//! Symbol and import extraction, native and parallel.
//!
//! Same queries and the same per-capture rules as the TypeScript parser, so
//! the two produce the same symbols and the same import edges. What changes is
//! that this runs on every core against native grammars rather than one core
//! against wasm.

use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Parser, Query, QueryCursor};

pub const TS_QUERY: &str = r#"
(function_declaration) @function
(generator_function_declaration) @function
(class_declaration) @class
(method_definition) @method
(interface_declaration) @interface
(type_alias_declaration) @type
(enum_declaration) @enum
(variable_declarator) @variable
(import_statement) @import
(export_statement) @export
"#;

pub const PY_QUERY: &str = r#"
(function_definition) @function
(class_definition) @class
(import_statement) @import
(import_from_statement) @import_from
"#;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Grammar {
    Typescript,
    Tsx,
    Python,
}

pub struct Symbol {
    pub kind: String,
    pub name: String,
    /// Identity that survives cosmetic edits, unlike the positional id the
    /// store derives from `start_line`/`start_column`.
    pub symbol_key: String,
    /// The contract a caller depends on: the declaration without its body.
    pub interface_sha: String,
    /// The implementation. `None` where the declaration has no body, so a
    /// signature that does not apply is absent rather than invented.
    pub body_sha: Option<String>,
    /// Enclosing declaration name for a member, empty at module level. Two
    /// classes with a same-named method must not share an identity.
    pub scope: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub exported: bool,
    pub default_export: bool,
    pub signature: String,
}

/// A use of something imported from another module.
///
/// `name` is the name as the defining module exports it, not the local alias,
/// so it can be matched against that module's symbol table directly.
pub struct Reference {
    pub name: String,
    pub module: String,
    pub line: u32,
    pub column: u32,
}

/// One module dependency and the exact source statement that produced it.
pub struct Import {
    pub specifier: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Default)]
pub struct Parsed {
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub refs: Vec<Reference>,
    pub execution_entries: Vec<crate::http_flow::ExecutionEntry>,
    /// The file's meaning with comments and formatting removed. Empty when no
    /// grammar covers the file, which callers read as "not applicable".
    pub syntax_sha: String,
    /// The sorted set of modules and imported names this file depends on.
    pub relation_set_sha: String,
}

/// A name this file bound from an import: local alias -> exported name.
struct Binding {
    local: String,
    exported: String,
    module: String,
    /// A Python `from pkg import child` may bind the child module as a
    /// namespace. A qualified use such as `child.run()` resolves through
    /// `pkg.child`, while a direct `child()` still means an export of `pkg`.
    namespace_module: Option<String>,
    /// Python's unaliased `import pkg.db` binds `pkg`, but a useful exported
    /// symbol appears only after the full `pkg.db` qualifier in a use.
    module_path_bound: bool,
    /// Lexical scope that owns the import. This keeps a function-local import
    /// from resolving same-named identifiers elsewhere in the module.
    scope_start: usize,
    scope_end: usize,
}

fn python_from_namespace_module(module: &str, imported: &str) -> String {
    if module.ends_with('.') {
        format!("{module}{imported}")
    } else {
        format!("{module}.{imported}")
    }
}

/// The name of the class or interface a member belongs to, if any.
///
/// Used only for identity, so an unnamed enclosing declaration contributes
/// nothing rather than a guess.
fn enclosing_declaration_name(node: Node, bytes: &[u8]) -> String {
    let mut current = node;
    while let Some(parent) = current.parent() {
        current = parent;
        if matches!(
            current.kind(),
            "class_declaration"
                | "abstract_class_declaration"
                | "class_definition"
                | "interface_declaration"
                | "enum_declaration"
        ) {
            if let Some(name) = current.child_by_field_name("name") {
                if let Ok(text) = name.utf8_text(bytes) {
                    return text.to_string();
                }
            }
            return String::new();
        }
    }
    String::new()
}

fn lexical_scope(mut node: Node) -> Node {
    while let Some(parent) = node.parent() {
        node = parent;
        if matches!(
            node.kind(),
            "function_definition" | "lambda" | "class_definition" | "module" | "program"
        ) {
            return node;
        }
    }
    node
}

pub fn grammar_for(path: &str, lang: &str) -> Option<Grammar> {
    if lang == "python" {
        return Some(Grammar::Python);
    }
    if lang != "typescript" && lang != "javascript" {
        return None;
    }
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".tsx") || lower.ends_with(".jsx") || lang == "javascript" {
        Some(Grammar::Tsx)
    } else {
        Some(Grammar::Typescript)
    }
}

fn language_of(grammar: Grammar) -> Language {
    match grammar {
        Grammar::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Grammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Grammar::Python => tree_sitter_python::LANGUAGE.into(),
    }
}

/// Compiled queries, built once for the whole process.
///
/// Compiling a query costs far more than parsing a small file, so doing it per
/// worker thread made short scans mostly query construction. Queries are
/// immutable once built, so every thread can share these.
struct Compiled {
    typescript: (Language, Query),
    tsx: (Language, Query),
    python: (Language, Query),
}

static COMPILED: std::sync::OnceLock<Compiled> = std::sync::OnceLock::new();

fn compiled() -> &'static Compiled {
    COMPILED.get_or_init(|| {
        let typescript: Language = language_of(Grammar::Typescript);
        let tsx: Language = language_of(Grammar::Tsx);
        let python: Language = language_of(Grammar::Python);
        Compiled {
            typescript: (
                typescript.clone(),
                Query::new(&typescript, TS_QUERY).expect("typescript query"),
            ),
            tsx: (tsx.clone(), Query::new(&tsx, TS_QUERY).expect("tsx query")),
            python: (
                python.clone(),
                Query::new(&python, PY_QUERY).expect("python query"),
            ),
        }
    })
}

/// A parser is stateful and cannot be shared, so rayon still hands one of
/// these to each worker — but it is now cheap to make.
pub struct Engines {
    parser: Parser,
}

impl Engines {
    pub fn new() -> Self {
        // Force compilation on the first thread rather than racing later.
        let _ = compiled();
        Self {
            parser: Parser::new(),
        }
    }
}

impl Default for Engines {
    fn default() -> Self {
        Self::new()
    }
}

fn first_line(text: &str) -> String {
    let line = text.split('\n').next().unwrap_or("").trim();
    if line.chars().count() > 160 {
        let truncated: String = line.chars().take(160).collect();
        format!("{truncated}…")
    } else {
        line.to_string()
    }
}

/// A constant's whole declaration, flattened to one line.
///
/// The values *are* the signature for a constant — a union written across
/// several lines loses everything useful if only its first line is kept, and
/// the values are the reason to record it at all.
fn flattened(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() > 240 {
        let truncated: String = joined.chars().take(240).collect();
        format!("{truncated}…")
    } else {
        joined
    }
}

fn strip_quotes(text: &str) -> &str {
    text.trim_matches(|c| c == '\'' || c == '"' || c == '`')
}

/// Whether a declaration sits under an `export`.
///
/// The nesting differs by declaration kind: a function_declaration's parent is
/// the export_statement, but `export const x = ...` goes declarator →
/// lexical_declaration → export_statement. Checking a fixed depth got the
/// second case wrong and marked every exported const as private, which made
/// exported utilities invisible to impact analysis. Walking up a bounded
/// number of ancestors handles both without depending on the exact shape.
fn is_exported_ts(node: Node) -> bool {
    let mut current = node.parent();
    for _ in 0..3 {
        let Some(ancestor) = current else {
            return false;
        };
        if ancestor.kind() == "export_statement" {
            return true;
        }
        current = ancestor.parent();
    }
    false
}

fn first_declared_name(node: Node, bytes: &[u8]) -> Option<String> {
    if node.kind() == "identifier" {
        return node.utf8_text(bytes).ok().map(str::to_string);
    }
    if let Some(name) = node.child_by_field_name("name") {
        if let Ok(text) = name.utf8_text(bytes) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    let mut cursor = node.walk();
    let found = node
        .named_children(&mut cursor)
        .find_map(|child| first_declared_name(child, bytes));
    found
}

/** Local declaration names exported through the module's `default` slot. */
fn default_export_names(root: Node, bytes: &[u8]) -> std::collections::HashSet<String> {
    fn visit(node: Node, bytes: &[u8], names: &mut std::collections::HashSet<String>) {
        if node.kind() == "export_statement" {
            let is_default = node
                .utf8_text(bytes)
                .is_ok_and(|text| text.trim_start().starts_with("export default"));
            if is_default {
                let target = node
                    .child_by_field_name("declaration")
                    .or_else(|| node.child_by_field_name("value"));
                if let Some(name) = target.and_then(|target| first_declared_name(target, bytes)) {
                    names.insert(name);
                }
            }
        }

        if node.kind() == "export_specifier" {
            let local = node
                .child_by_field_name("name")
                .and_then(|value| value.utf8_text(bytes).ok());
            let alias = node
                .child_by_field_name("alias")
                .and_then(|value| value.utf8_text(bytes).ok());
            if let (Some(local), Some("default")) = (local, alias) {
                names.insert(local.to_string());
            }
        }

        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            visit(child, bytes, names);
        }
    }

    let mut names = std::collections::HashSet::new();
    visit(root, bytes, &mut names);
    names
}

/// Names bound by one `import` statement.
///
/// Walked rather than queried: the shapes differ enough between default,
/// named, aliased and namespace imports that a query per case would be longer
/// than the walk, and this has to handle all of them to resolve usages.
fn bindings_from_import(node: Node, bytes: &[u8], grammar: Grammar, out: &mut Vec<Binding>) {
    let text = |n: Node| n.utf8_text(bytes).unwrap_or("").to_string();
    let scope = lexical_scope(node);
    let scope_start = scope.start_byte();
    let scope_end = scope.end_byte();

    if grammar == Grammar::Python {
        // `import m` / `import m as n`: there is no module_name field on an
        // import_statement — each imported name *is* a module, and a use like
        // `m.run()` is a use of the module itself, recorded the same way a TS
        // `import * as ns` is. Leaving module empty made every such binding
        // unresolvable.
        if node.kind() == "import_statement" {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                match child.kind() {
                    "dotted_name" => {
                        let module = text(child);
                        if !module.is_empty() {
                            let local = module.split('.').next().unwrap_or(&module).to_string();
                            out.push(Binding {
                                local,
                                exported: "*".to_string(),
                                module,
                                namespace_module: None,
                                module_path_bound: true,
                                scope_start,
                                scope_end,
                            });
                        }
                    }
                    "aliased_import" => {
                        let module = child
                            .child_by_field_name("name")
                            .map(text)
                            .unwrap_or_default();
                        let local = child
                            .child_by_field_name("alias")
                            .map(text)
                            .unwrap_or_else(|| module.clone());
                        if !module.is_empty() {
                            out.push(Binding {
                                local,
                                exported: "*".to_string(),
                                module,
                                namespace_module: None,
                                module_path_bound: false,
                                scope_start,
                                scope_end,
                            });
                        }
                    }
                    _ => {}
                }
            }
            return;
        }

        let module_node = node.child_by_field_name("module_name");
        let module = module_node.map(text).unwrap_or_default();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                // `from m import a`
                "dotted_name" | "identifier" => {
                    // The module name is a dotted_name too; do not import itself.
                    if module_node.is_some_and(|m| m.id() == child.id()) {
                        continue;
                    }
                    let name = text(child);
                    if !name.is_empty() {
                        out.push(Binding {
                            local: name.clone(),
                            exported: name.clone(),
                            namespace_module: Some(python_from_namespace_module(&module, &name)),
                            module: module.clone(),
                            module_path_bound: false,
                            scope_start,
                            scope_end,
                        });
                    }
                }
                // `from m import a as b`
                "aliased_import" => {
                    let exported = child
                        .child_by_field_name("name")
                        .map(text)
                        .unwrap_or_default();
                    let local = child
                        .child_by_field_name("alias")
                        .map(text)
                        .unwrap_or_else(|| exported.clone());
                    if !exported.is_empty() {
                        out.push(Binding {
                            local,
                            namespace_module: Some(python_from_namespace_module(
                                &module, &exported,
                            )),
                            exported,
                            module: module.clone(),
                            module_path_bound: false,
                            scope_start,
                            scope_end,
                        });
                    }
                }
                _ => {}
            }
        }
        return;
    }

    let Some(source) = node.child_by_field_name("source") else {
        return;
    };
    let module = source
        .utf8_text(bytes)
        .map(strip_quotes)
        .unwrap_or("")
        .to_string();
    if module.is_empty() {
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "import_clause" {
            continue;
        }
        let mut clause = child.walk();
        for part in child.children(&mut clause) {
            match part.kind() {
                // `import Default from "m"`
                "identifier" => out.push(Binding {
                    local: text(part),
                    exported: "default".to_string(),
                    module: module.clone(),
                    namespace_module: None,
                    module_path_bound: false,
                    scope_start,
                    scope_end,
                }),
                // `import * as ns from "m"`
                "namespace_import" => {
                    if let Some(alias) = part.child(part.child_count().saturating_sub(1)) {
                        out.push(Binding {
                            local: text(alias),
                            exported: "*".to_string(),
                            module: module.clone(),
                            namespace_module: None,
                            module_path_bound: false,
                            scope_start,
                            scope_end,
                        });
                    }
                }
                // `import { a, b as c } from "m"`
                "named_imports" => {
                    let mut named = part.walk();
                    for spec in part.children(&mut named) {
                        if spec.kind() != "import_specifier" {
                            continue;
                        }
                        let exported = spec
                            .child_by_field_name("name")
                            .map(text)
                            .unwrap_or_default();
                        let local = spec
                            .child_by_field_name("alias")
                            .map(text)
                            .unwrap_or_else(|| exported.clone());
                        if !exported.is_empty() {
                            out.push(Binding {
                                local,
                                exported,
                                module: module.clone(),
                                namespace_module: None,
                                module_path_bound: false,
                                scope_start,
                                scope_end,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// Every identifier occurrence that resolves to an imported binding.
///
/// The whole tree is walked, but only names that were actually imported are
/// kept, which is what stops this from emitting every token in the file.
fn member_parts<'a>(node: Node<'a>) -> Option<(Node<'a>, Node<'a>)> {
    let parent = node.parent()?;
    match parent.kind() {
        "member_expression" => Some((
            parent.child_by_field_name("object")?,
            parent.child_by_field_name("property")?,
        )),
        "attribute" => Some((
            parent.child_by_field_name("object")?,
            parent.child_by_field_name("attribute")?,
        )),
        _ => None,
    }
}

fn is_member_property(node: Node) -> bool {
    member_parts(node).is_some_and(|(_, property)| property.id() == node.id())
}

fn namespace_member(node: Node, binding: &Binding, bytes: &[u8]) -> Option<String> {
    let mut chain = vec![node.utf8_text(bytes).ok()?.to_string()];
    let mut current = node;
    while let Some(parent) = current.parent() {
        let Some((object, property)) = member_parts(current) else {
            break;
        };
        if object.id() != current.id() {
            break;
        }
        chain.push(property.utf8_text(bytes).ok()?.to_string());
        current = parent;
    }

    if binding.module_path_bound {
        let qualifier: Vec<&str> = binding.module.split('.').collect();
        if chain.len() <= qualifier.len()
            || !chain
                .iter()
                .take(qualifier.len())
                .map(String::as_str)
                .eq(qualifier.iter().copied())
        {
            return None;
        }
        return chain.get(qualifier.len()).cloned();
    }

    chain.get(1).cloned()
}

fn binding_pattern_any(node: Node, predicate: &mut impl FnMut(Node) -> bool) -> bool {
    if matches!(
        node.kind(),
        "identifier" | "type_identifier" | "shorthand_property_identifier_pattern"
    ) {
        return predicate(node);
    }

    // These nodes are evaluated to locate a store or select a property; names
    // inside them are reads, not declarations. Computed object-pattern keys
    // follow the same rule.
    if matches!(
        node.kind(),
        "attribute"
            | "subscript"
            | "member_expression"
            | "subscript_expression"
            | "computed_property_name"
    ) {
        return false;
    }

    // Defaults and object keys can contain arbitrary expressions. Descend only
    // through the part of each construct that is actually a binding pattern.
    let binding_field = match node.kind() {
        "assignment_pattern" | "object_assignment_pattern" => Some("left"),
        "pair_pattern" => Some("value"),
        "default_parameter" | "typed_default_parameter" => Some("name"),
        _ => None,
    };
    if let Some(field) = binding_field {
        return node
            .child_by_field_name(field)
            .is_some_and(|child| binding_pattern_any(child, predicate));
    }

    let mut cursor = node.walk();
    let found = node
        .named_children(&mut cursor)
        .any(|child| binding_pattern_any(child, predicate));
    found
}

fn pattern_binds(node: Node, name: &str, bytes: &[u8]) -> bool {
    binding_pattern_any(node, &mut |candidate| {
        candidate.utf8_text(bytes).is_ok_and(|value| value == name)
    })
}

fn pattern_binds_node(pattern: Node, node: Node) -> bool {
    binding_pattern_any(pattern, &mut |candidate| candidate.id() == node.id())
}

fn field_binds(node: Node, field: &str, name: &str, bytes: &[u8]) -> bool {
    node.child_by_field_name(field)
        .is_some_and(|target| pattern_binds(target, name, bytes))
}

fn field_binds_node(node: Node, field: &str, candidate: Node) -> bool {
    node.child_by_field_name(field)
        .is_some_and(|target| pattern_binds_node(target, candidate))
}

fn within(node: Node, container: Node) -> bool {
    container.start_byte() <= node.start_byte() && node.end_byte() <= container.end_byte()
}

fn python_comprehension(node: Node) -> bool {
    matches!(
        node.kind(),
        "list_comprehension"
            | "set_comprehension"
            | "dictionary_comprehension"
            | "generator_expression"
    )
}

/** The first iterable is evaluated by the surrounding scope, not the comprehension scope. */
fn python_first_comprehension_iterable(scope: Node) -> Option<Node> {
    let mut cursor = scope.walk();
    let iterable = scope
        .named_children(&mut cursor)
        .find(|child| child.kind() == "for_in_clause")
        .and_then(|clause| clause.child_by_field_name("right"));
    iterable
}

fn python_comprehension_binds(scope: Node, name: &str, bytes: &[u8]) -> bool {
    let mut cursor = scope.walk();
    let binds = scope
        .named_children(&mut cursor)
        .filter(|child| child.kind() == "for_in_clause")
        .any(|clause| field_binds(clause, "left", name, bytes));
    binds
}

/** Whether this node executes inside a nested Python scope rather than its parent. */
fn python_scope_owns_node(scope: Node, node: Node) -> bool {
    if python_comprehension(scope) {
        return !python_first_comprehension_iterable(scope)
            .is_some_and(|right| within(node, right));
    }
    scope
        .child_by_field_name("body")
        .is_some_and(|body| within(node, body))
}

/**
 * Class namespaces are not closure scopes. A method, nested class, or
 * comprehension body cannot resolve a bare name through the containing class.
 * An expression can still see an enclosing class namespace when it executes
 * outside a nested body. A class's own header executes before its namespace
 * exists, so only its body can resolve through its local bindings.
 */
fn python_class_binding_visible(node: Node, class_scope: Node) -> bool {
    if !class_scope
        .child_by_field_name("body")
        .is_some_and(|body| within(node, body))
    {
        return false;
    }
    let mut current = node.parent();
    while let Some(scope) = current {
        if scope.id() == class_scope.id() {
            return true;
        }
        if (matches!(
            scope.kind(),
            "function_definition" | "lambda" | "class_definition"
        ) || python_comprehension(scope))
            && python_scope_owns_node(scope, node)
        {
            return false;
        }
        current = scope.parent();
    }
    false
}

/** A binding site is a declaration, not a use of an imported value. */
fn python_binding_occurrence(node: Node) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        let in_field = |field: &str| {
            parent
                .child_by_field_name(field)
                .is_some_and(|target| within(node, target))
        };
        match parent.kind() {
            "parameters" | "lambda_parameters" => return true,
            "default_parameter" | "typed_default_parameter" => return in_field("name"),
            "typed_parameter" => return !in_field("type"),
            "assignment" | "augmented_assignment" | "for_statement" | "for_in_clause" => {
                return field_binds_node(parent, "left", node)
            }
            "named_expression" | "function_definition" | "class_definition" => {
                return in_field("name")
            }
            "except_clause" | "as_pattern" => return in_field("alias"),
            "call" | "return_statement" | "expression_statement" | "block" => return false,
            _ => current = parent,
        }
    }
    false
}

fn parameters_bind(parameters: Node, name: &str, bytes: &[u8]) -> bool {
    let mut cursor = parameters.walk();
    for parameter in parameters.named_children(&mut cursor) {
        let binds = match parameter.kind() {
            "identifier" | "tuple_pattern" | "list_splat_pattern" | "dictionary_splat_pattern" => {
                pattern_binds(parameter, name, bytes)
            }
            "default_parameter" | "typed_default_parameter" => {
                field_binds(parameter, "name", name, bytes)
            }
            "typed_parameter" => {
                let type_node = parameter.child_by_field_name("type");
                let mut children = parameter.walk();
                let found = parameter.named_children(&mut children).any(|child| {
                    type_node.is_none_or(|kind| kind.id() != child.id())
                        && pattern_binds(child, name, bytes)
                });
                found
            }
            _ => false,
        };
        if binds {
            return true;
        }
    }
    false
}

fn scope_declares_global(scope: Node, name: &str, bytes: &[u8]) -> bool {
    fn visit(node: Node, scope_id: usize, name: &str, bytes: &[u8]) -> bool {
        if node.id() != scope_id
            && matches!(
                node.kind(),
                "function_definition" | "lambda" | "class_definition"
            )
        {
            return false;
        }
        if node.kind() == "global_statement" {
            let mut cursor = node.walk();
            return node.named_children(&mut cursor).any(|child| {
                child.kind() == "identifier"
                    && child.utf8_text(bytes).is_ok_and(|value| value == name)
            });
        }
        let mut cursor = node.walk();
        let found = node
            .named_children(&mut cursor)
            .any(|child| visit(child, scope_id, name, bytes));
        found
    }
    visit(scope, scope.id(), name, bytes)
}

fn scope_binds(scope: Node, name: &str, bytes: &[u8]) -> bool {
    if scope
        .child_by_field_name("parameters")
        .is_some_and(|parameters| parameters_bind(parameters, name, bytes))
    {
        return true;
    }

    fn visit(node: Node, scope_id: usize, name: &str, bytes: &[u8]) -> bool {
        if node.id() != scope_id
            && matches!(
                node.kind(),
                "function_definition" | "lambda" | "class_definition"
            )
        {
            // The declaration name belongs to the outer scope; its body does not.
            return matches!(node.kind(), "function_definition" | "class_definition")
                && field_binds(node, "name", name, bytes);
        }

        let binds = match node.kind() {
            "assignment" | "augmented_assignment" | "for_statement" => {
                field_binds(node, "left", name, bytes)
            }
            "named_expression" => field_binds(node, "name", name, bytes),
            "except_clause" => field_binds(node, "alias", name, bytes),
            "as_pattern" => field_binds(node, "alias", name, bytes),
            _ => false,
        };
        if binds {
            return true;
        }

        let mut cursor = node.walk();
        let found = node
            .named_children(&mut cursor)
            .any(|child| visit(child, scope_id, name, bytes));
        found
    }

    scope
        .child_by_field_name("body")
        .is_some_and(|body| visit(body, scope.id(), name, bytes))
}

/** Whether a scope nested inside the import shadows its local name. */
fn python_shadowed(node: Node, binding: &Binding, bytes: &[u8]) -> bool {
    let mut current = node.parent();
    while let Some(scope) = current {
        if python_comprehension(scope) {
            if python_scope_owns_node(scope, node)
                && python_comprehension_binds(scope, &binding.local, bytes)
            {
                return true;
            }
            current = scope.parent();
            continue;
        }
        if matches!(
            scope.kind(),
            "function_definition" | "lambda" | "class_definition" | "module"
        ) {
            if scope.start_byte() == binding.scope_start && scope.end_byte() == binding.scope_end {
                return false;
            }

            // Defaults, annotations and bases execute in the parent scope.
            // Class locals additionally do not close over nested executable
            // scopes (methods and comprehension bodies).
            let binding_visible = match scope.kind() {
                "function_definition" | "lambda" => python_scope_owns_node(scope, node),
                "class_definition" => python_class_binding_visible(node, scope),
                _ => true,
            };
            if binding_visible
                && !scope_declares_global(scope, &binding.local, bytes)
                && scope_binds(scope, &binding.local, bytes)
            {
                return true;
            }
        }
        current = scope.parent();
    }
    false
}

fn typescript_for_binding(node: Node, kind: &str, name: &str, bytes: &[u8]) -> bool {
    node.kind() == "for_in_statement"
        && node.child_by_field_name("kind").is_some_and(|declaration| {
            declaration
                .utf8_text(bytes)
                .is_ok_and(|value| value == kind)
        })
        && field_binds(node, "left", name, bytes)
}

fn typescript_binding_occurrence(node: Node) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        let in_field = |field: &str| {
            parent
                .child_by_field_name(field)
                .is_some_and(|target| within(node, target))
        };
        match parent.kind() {
            "variable_declarator" => return field_binds_node(parent, "name", node),
            "required_parameter" | "optional_parameter" => {
                return ["pattern", "name"]
                    .iter()
                    .any(|field| field_binds_node(parent, field, node))
            }
            "function_declaration"
            | "generator_function_declaration"
            | "class_declaration"
            | "abstract_class_declaration" => return in_field("name"),
            "function_expression" | "generator_function" => return in_field("name"),
            "arrow_function" => return field_binds_node(parent, "parameter", node),
            "for_in_statement" => {
                return parent.child_by_field_name("kind").is_some()
                    && field_binds_node(parent, "left", node)
            }
            "formal_parameters" => return true,
            "call_expression"
            | "return_statement"
            | "expression_statement"
            | "statement_block"
            | "program" => return false,
            _ => current = parent,
        }
    }
    false
}

fn typescript_parameters_bind(parameters: Node, name: &str, bytes: &[u8]) -> bool {
    let mut cursor = parameters.walk();
    let found = parameters.named_children(&mut cursor).any(|parameter| {
        if parameter.kind() == "identifier" {
            return pattern_binds(parameter, name, bytes);
        }
        ["pattern", "name", "parameter"]
            .iter()
            .any(|field| field_binds(parameter, field, name, bytes))
    });
    found
}

fn typescript_function_parameters_bind(scope: Node, name: &str, bytes: &[u8]) -> bool {
    scope
        .child_by_field_name("parameters")
        .is_some_and(|parameters| typescript_parameters_bind(parameters, name, bytes))
        || field_binds(scope, "parameter", name, bytes)
}

fn typescript_inner_name_binds(scope: Node, name: &str, bytes: &[u8]) -> bool {
    matches!(
        scope.kind(),
        "function_expression"
            | "generator_function"
            | "class_declaration"
            | "abstract_class_declaration"
            | "class"
    ) && field_binds(scope, "name", name, bytes)
}

fn typescript_function_scope(node: Node) -> bool {
    matches!(
        node.kind(),
        "function_declaration"
            | "generator_function_declaration"
            | "function_expression"
            | "generator_function"
            | "arrow_function"
            | "method_definition"
    )
}

fn typescript_var_scope(node: Node) -> bool {
    typescript_function_scope(node) || node.kind() == "class_static_block"
}

/** `var` crosses statement blocks and belongs to the nearest function or static-block scope. */
fn typescript_function_var_binds(scope: Node, name: &str, bytes: &[u8]) -> bool {
    fn visit(node: Node, scope_id: usize, name: &str, bytes: &[u8]) -> bool {
        if node.id() != scope_id
            && (typescript_function_scope(node)
                || matches!(
                    node.kind(),
                    "class_declaration" | "abstract_class_declaration" | "class"
                ))
        {
            return false;
        }
        if node.kind() == "variable_declarator"
            && node
                .parent()
                .is_some_and(|parent| parent.kind() == "variable_declaration")
            && field_binds(node, "name", name, bytes)
        {
            return true;
        }
        if typescript_for_binding(node, "var", name, bytes) {
            return true;
        }
        let mut cursor = node.walk();
        let found = node
            .named_children(&mut cursor)
            .any(|child| visit(child, scope_id, name, bytes));
        found
    }
    visit(scope, scope.id(), name, bytes)
}

fn typescript_scope_binds(scope: Node, name: &str, bytes: &[u8]) -> bool {
    if typescript_function_parameters_bind(scope, name, bytes)
        || typescript_inner_name_binds(scope, name, bytes)
    {
        return true;
    }
    if typescript_var_scope(scope) && typescript_function_var_binds(scope, name, bytes) {
        return true;
    }
    if scope.kind() == "catch_clause"
        && ["parameter", "name"]
            .iter()
            .any(|field| field_binds(scope, field, name, bytes))
    {
        return true;
    }

    fn visit(node: Node, scope_id: usize, name: &str, bytes: &[u8]) -> bool {
        if node.id() != scope_id
            && matches!(
                node.kind(),
                "function_declaration"
                    | "generator_function_declaration"
                    | "function_expression"
                    | "generator_function"
                    | "arrow_function"
                    | "method_definition"
                    | "class_declaration"
                    | "abstract_class_declaration"
                    | "class"
                    | "for_in_statement"
                    | "statement_block"
                    | "catch_clause"
            )
        {
            // A declaration name belongs to the surrounding block; its body
            // and parameters belong to the nested scope.
            return matches!(
                node.kind(),
                "function_declaration"
                    | "generator_function_declaration"
                    | "class_declaration"
                    | "abstract_class_declaration"
            ) && field_binds(node, "name", name, bytes);
        }

        if node.kind() == "variable_declarator" && field_binds(node, "name", name, bytes) {
            return true;
        }

        let mut cursor = node.walk();
        let found = node
            .named_children(&mut cursor)
            .any(|child| visit(child, scope_id, name, bytes));
        found
    }

    visit(scope, scope.id(), name, bytes)
}

type TypescriptScopeCache =
    std::collections::HashMap<usize, std::collections::HashMap<String, bool>>;

fn cached_typescript_scope_binds(
    scope: Node,
    name: &str,
    bytes: &[u8],
    cache: &mut TypescriptScopeCache,
) -> bool {
    if let Some(cached) = cache
        .get(&scope.id())
        .and_then(|bindings| bindings.get(name))
    {
        return *cached;
    }
    let binds = typescript_scope_binds(scope, name, bytes);
    cache
        .entry(scope.id())
        .or_default()
        .insert(name.to_string(), binds);
    binds
}

fn typescript_function_shadows(
    scope: Node,
    node: Node,
    name: &str,
    bytes: &[u8],
    cache: &mut TypescriptScopeCache,
) -> bool {
    if scope
        .child_by_field_name("body")
        .is_some_and(|body| within(node, body))
    {
        return cached_typescript_scope_binds(scope, name, bytes, cache);
    }
    let parameters = scope.child_by_field_name("parameters");
    let parameter = scope.child_by_field_name("parameter");
    let parameter_scope = parameters.is_some_and(|parameters| within(node, parameters))
        || parameter.is_some_and(|parameter| within(node, parameter))
        || scope
            .child_by_field_name("return_type")
            .is_some_and(|return_type| within(node, return_type));
    let type_parameter_scope = scope
        .child_by_field_name("type_parameters")
        .is_some_and(|type_parameters| within(node, type_parameters));
    (parameter_scope
        && (typescript_function_parameters_bind(scope, name, bytes)
            || typescript_inner_name_binds(scope, name, bytes)))
        || (type_parameter_scope && typescript_inner_name_binds(scope, name, bytes))
}

fn typescript_for_shadows(scope: Node, name: &str, bytes: &[u8]) -> bool {
    typescript_for_binding(scope, "let", name, bytes)
        || typescript_for_binding(scope, "const", name, bytes)
}

/** Whether a TypeScript/JavaScript scope nested inside the import shadows it. */
fn typescript_shadowed(
    node: Node,
    binding: &Binding,
    bytes: &[u8],
    cache: &mut TypescriptScopeCache,
) -> bool {
    let mut current = node.parent();
    while let Some(scope) = current {
        if matches!(
            scope.kind(),
            "function_declaration"
                | "generator_function_declaration"
                | "function_expression"
                | "generator_function"
                | "arrow_function"
                | "method_definition"
                | "class_static_block"
                | "class_declaration"
                | "abstract_class_declaration"
                | "class"
                | "for_in_statement"
                | "statement_block"
                | "catch_clause"
                | "program"
        ) {
            if scope.start_byte() == binding.scope_start && scope.end_byte() == binding.scope_end {
                return false;
            }
            let shadowed = if typescript_function_scope(scope) {
                typescript_function_shadows(scope, node, &binding.local, bytes, cache)
            } else if scope.kind() == "for_in_statement" {
                typescript_for_shadows(scope, &binding.local, bytes)
            } else {
                cached_typescript_scope_binds(scope, &binding.local, bytes, cache)
            };
            if shadowed {
                return true;
            }
        }
        current = scope.parent();
    }
    false
}

fn collect_refs(
    root: Node,
    bytes: &[u8],
    bindings: &[Binding],
    grammar: Grammar,
) -> Vec<Reference> {
    if bindings.is_empty() {
        return Vec::new();
    }

    let mut refs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut typescript_scope_cache = TypescriptScopeCache::new();
    let mut cursor = root.walk();

    loop {
        let node = cursor.node();

        // The import statement itself is not a use of what it imports, so its
        // whole subtree is skipped rather than just its identifiers.
        let is_import = matches!(node.kind(), "import_statement" | "import_from_statement");

        if !is_import {
            // A non-computed member property is not a lexical variable use:
            // in `object.query`, `query` must not resolve to an unrelated
            // named import. The object can be a namespace import, though, in
            // which case its member is the exported symbol we need to record.
            let binding_occurrence = match grammar {
                Grammar::Python => python_binding_occurrence(node),
                Grammar::Typescript | Grammar::Tsx => typescript_binding_occurrence(node),
            };
            if node.kind() == "identifier" && !is_member_property(node) && !binding_occurrence {
                if let Ok(text) = node.utf8_text(bytes) {
                    let binding = bindings
                        .iter()
                        .filter(|binding| {
                            binding.local == text
                                && binding.scope_start <= node.start_byte()
                                && node.end_byte() <= binding.scope_end
                        })
                        .min_by_key(|binding| binding.scope_end - binding.scope_start);
                    if let Some(binding) = binding {
                        let shadowed = match grammar {
                            Grammar::Python => python_shadowed(node, binding, bytes),
                            Grammar::Typescript | Grammar::Tsx => typescript_shadowed(
                                node,
                                binding,
                                bytes,
                                &mut typescript_scope_cache,
                            ),
                        };
                        if !shadowed {
                            let line = node.start_position().row as u32 + 1;
                            let column = node.start_position().column as u32;
                            let mut module = binding.module.clone();
                            let name = if grammar == Grammar::Python {
                                if let (Some(namespace), Some(member)) = (
                                    binding.namespace_module.as_ref(),
                                    namespace_member(node, binding, bytes),
                                ) {
                                    module = namespace.clone();
                                    member
                                } else if binding.exported == "*" {
                                    namespace_member(node, binding, bytes)
                                        .unwrap_or_else(|| binding.exported.clone())
                                } else {
                                    binding.exported.clone()
                                }
                            } else if binding.exported == "*" {
                                namespace_member(node, binding, bytes)
                                    .unwrap_or_else(|| binding.exported.clone())
                            } else {
                                binding.exported.clone()
                            };
                            if seen.insert((name.clone(), module.clone(), line, column)) {
                                refs.push(Reference {
                                    name,
                                    module,
                                    line,
                                    column,
                                });
                            }
                        }
                    }
                }
            }
            if cursor.goto_first_child() {
                continue;
            }
        }

        // No child to descend into: move sideways, or climb until we can.
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return refs;
            }
        }
    }
}

fn python_kind(node: Node) -> &'static str {
    // A decorated method nests one level deeper: function_definition →
    // decorated_definition → block → class_definition.
    let anchor = match node.parent() {
        Some(parent) if parent.kind() == "decorated_definition" => parent,
        _ => node,
    };
    let is_method = anchor
        .parent()
        .and_then(|p| p.parent())
        .is_some_and(|p| p.kind() == "class_definition");
    if is_method {
        "method"
    } else {
        "function"
    }
}

/// Check a structural query compiles for at least one of the wanted languages.
///
/// Returns the per-grammar compile errors when it compiles for none — an
/// invalid query must surface as an error, never as zero matches.
pub fn validate_query(query_source: &str, langs: &[String]) -> std::result::Result<(), String> {
    let mut grammars: Vec<Grammar> = Vec::new();
    for lang in langs {
        match lang.as_str() {
            "python" => grammars.push(Grammar::Python),
            "typescript" => {
                grammars.push(Grammar::Typescript);
                grammars.push(Grammar::Tsx);
            }
            "javascript" => grammars.push(Grammar::Tsx),
            _ => {}
        }
    }
    grammars.dedup_by_key(|g| *g as u8);

    let mut errors: Vec<String> = Vec::new();
    for grammar in &grammars {
        match Query::new(&language_of(*grammar), query_source) {
            Ok(_) => return Ok(()),
            Err(error) => errors.push(error.to_string()),
        }
    }
    Err(errors
        .first()
        .cloned()
        .unwrap_or_else(|| "query is valid for none of the requested languages".to_string()))
}

pub struct Hit {
    pub line: u32,
    pub end_line: u32,
    pub text: String,
    pub capture: String,
}

/// Run one tree-sitter query over one file.
///
/// The query is compiled per call rather than cached: structural search is
/// interactive and ad-hoc, so the pattern is different nearly every time and a
/// cache would only hold garbage.
pub fn search(
    path: &str,
    lang: &str,
    source: &str,
    query_source: &str,
    text_filter: Option<&str>,
    cap: usize,
) -> Vec<Hit> {
    if cap == 0 {
        return Vec::new();
    }
    let Some(grammar) = grammar_for(path, lang) else {
        return Vec::new();
    };
    let language = language_of(grammar);
    let Ok(query) = Query::new(&language, query_source) else {
        return Vec::new();
    };

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };

    let bytes = source.as_bytes();
    let names = query.capture_names();
    let mut hits = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(&query, tree.root_node(), bytes);

    while let Some((mat, index)) = captures.next() {
        let capture = mat.captures[*index];
        let node = capture.node;
        let text = node.utf8_text(bytes).unwrap_or("");
        if text_filter.is_some_and(|needle| !text.to_lowercase().contains(needle)) {
            continue;
        }
        let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
        hits.push(Hit {
            line: node.start_position().row as u32 + 1,
            end_line: node.end_position().row as u32 + 1,
            text: if flat.chars().count() > 200 {
                flat.chars().take(200).collect::<String>() + "…"
            } else {
                flat
            },
            capture: names[capture.index as usize].to_string(),
        });
        if hits.len() >= cap {
            break;
        }
    }
    hits
}

pub fn parse(engines: &mut Engines, path: &str, lang: &str, source: &str) -> Parsed {
    let Some(grammar) = grammar_for(path, lang) else {
        return Parsed::default();
    };

    let shared = compiled();
    let (language, query) = match grammar {
        Grammar::Typescript => &shared.typescript,
        Grammar::Tsx => &shared.tsx,
        Grammar::Python => &shared.python,
    };

    if engines.parser.set_language(language).is_err() {
        return Parsed::default();
    }
    let Some(tree) = engines.parser.parse(source, None) else {
        return Parsed::default();
    };

    let bytes = source.as_bytes();
    let default_exports = if grammar == Grammar::Python {
        std::collections::HashSet::new()
    } else {
        default_export_names(tree.root_node(), bytes)
    };
    let names = query.capture_names();
    let mut symbols = Vec::new();
    let mut imports: Vec<Import> = Vec::new();
    let mut seen_imports = std::collections::HashSet::new();

    let mut push_import = |value: &str, start_line: u32, end_line: u32| {
        let trimmed = value.trim();
        if !trimmed.is_empty() && seen_imports.insert(trimmed.to_string()) {
            imports.push(Import {
                specifier: trimmed.to_string(),
                start_line,
                end_line,
            });
        }
    };

    let mut bindings: Vec<Binding> = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(query, tree.root_node(), bytes);

    while let Some((mat, index)) = captures.next() {
        let capture = mat.captures[*index];
        let node = capture.node;
        let label = names[capture.index as usize];

        if label == "import" || label == "import_from" {
            bindings_from_import(node, bytes, grammar, &mut bindings);
        }

        if label == "import" || label == "export" {
            let start_line = node.start_position().row as u32 + 1;
            let end_line = node.end_position().row as u32 + 1;
            if let Some(source_node) = node.child_by_field_name("source") {
                if let Ok(text) = source_node.utf8_text(bytes) {
                    push_import(strip_quotes(text), start_line, end_line);
                }
            }
            // Python `import a, b as c` — every comma-separated module, not
            // just the first: `child_by_field_name` only ever returns one.
            if grammar == Grammar::Python && label == "import" {
                let mut import_cursor = node.walk();
                for child in node.named_children(&mut import_cursor) {
                    match child.kind() {
                        "dotted_name" => {
                            if let Ok(text) = child.utf8_text(bytes) {
                                push_import(text, start_line, end_line);
                            }
                        }
                        "aliased_import" => {
                            if let Some(target) = child.child_by_field_name("name") {
                                if let Ok(text) = target.utf8_text(bytes) {
                                    push_import(text, start_line, end_line);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            continue;
        }

        if label == "import_from" {
            if let Some(module) = node.child_by_field_name("module_name") {
                if let Ok(text) = module.utf8_text(bytes) {
                    push_import(
                        text,
                        node.start_position().row as u32 + 1,
                        node.end_position().row as u32 + 1,
                    );
                }
            }
            continue;
        }

        let Some(name_node) = node.child_by_field_name("name") else {
            continue;
        };
        let Ok(name) = name_node.utf8_text(bytes) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }

        let text = node.utf8_text(bytes).unwrap_or("");
        let start_line = node.start_position().row as u32 + 1;
        let start_column = node.start_position().column as u32;
        let end_line = node.end_position().row as u32 + 1;
        let end_column = node.end_position().column as u32;

        let (interface, body) = crate::signature::symbol_signatures(node, bytes, grammar);

        if label == "variable" {
            let value_kind = node
                .child_by_field_name("value")
                .map(|v| v.kind().to_string())
                .unwrap_or_default();

            let callable = matches!(
                value_kind.as_str(),
                "arrow_function" | "function_expression" | "function" | "class"
            );
            let default_export = default_exports.contains(name);
            let exported = is_exported_ts(node) || default_export;

            if callable {
                symbols.push(Symbol {
                    kind: if value_kind == "class" {
                        "class"
                    } else {
                        "function"
                    }
                    .to_string(),
                    name: name.to_string(),
                    start_line,
                    start_column,
                    end_line,
                    end_column,
                    exported,
                    default_export,
                    signature: first_line(text),
                    symbol_key: String::new(),
                    interface_sha: crate::signature::interface_with_visibility(
                        &interface,
                        exported,
                        default_export,
                    ),
                    body_sha: body,
                    scope: String::new(),
                });
            } else if exported {
                // Exported constants are a codebase's vocabulary — the closed
                // sets of allowed values. Skipping them meant an agent could
                // read every symbol in a module and still invent a value the
                // union does not permit, which is exactly what happened.
                symbols.push(Symbol {
                    kind: "constant".to_string(),
                    name: name.to_string(),
                    start_line,
                    start_column,
                    end_line,
                    end_column,
                    exported: true,
                    default_export,
                    signature: flattened(text),
                    symbol_key: String::new(),
                    interface_sha: crate::signature::interface_with_visibility(
                        &interface,
                        true,
                        default_export,
                    ),
                    body_sha: body,
                    scope: String::new(),
                });
            }
            continue;
        }

        let kind = if label == "function" && grammar == Grammar::Python {
            python_kind(node).to_string()
        } else {
            label.to_string()
        };

        let default_export = grammar != Grammar::Python && default_exports.contains(name);
        let exported = if grammar == Grammar::Python {
            !name.starts_with('_')
        } else {
            is_exported_ts(node) || default_export
        };

        symbols.push(Symbol {
            kind,
            name: name.to_string(),
            start_line,
            start_column,
            end_line,
            end_column,
            exported,
            default_export,
            signature: first_line(text),
            symbol_key: String::new(),
            interface_sha: crate::signature::interface_with_visibility(
                &interface,
                exported,
                default_export,
            ),
            body_sha: body,
            scope: enclosing_declaration_name(node, bytes),
        });
    }

    // Same-named declarations in one file are distinguished by their order,
    // which only moves when that duplicate set itself changes — unlike a line
    // number, which moves whenever anything above it does.
    let mut ordinals: std::collections::HashMap<(String, String, String), u32> =
        std::collections::HashMap::new();
    for symbol in &mut symbols {
        // Scoped by the enclosing declaration: without it, inserting a method
        // into an earlier class renumbers a same-named method in a later one,
        // and a recorded dependency silently starts tracking the wrong symbol.
        let slot = ordinals
            .entry((
                symbol.kind.clone(),
                symbol.name.clone(),
                symbol.scope.clone(),
            ))
            .or_insert(0);
        symbol.symbol_key = crate::signature::symbol_key(
            path,
            &symbol.kind,
            &symbol.name,
            &symbol.scope,
            *slot,
        );
        *slot += 1;
    }

    let refs = collect_refs(tree.root_node(), bytes, &bindings, grammar);
    let execution_entries = if grammar == Grammar::Python {
        Vec::new()
    } else {
        crate::http_flow::extract(path, tree.root_node(), bytes)
    };
    let syntax_sha = crate::signature::file_syntax_sha(tree.root_node(), bytes, grammar);
    let relation_set_sha = crate::signature::relation_set_sha(&imports, &refs);
    Parsed {
        symbols,
        imports,
        refs,
        execution_entries,
        syntax_sha,
        relation_set_sha,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_named_default_exports_and_records_default_import_uses() {
        let mut engines = Engines::new();
        let definition = parse(
            &mut engines,
            "default.ts",
            "typescript",
            "export default function initialize() { return true; }",
        );
        assert!(definition
            .symbols
            .iter()
            .any(|symbol| symbol.name == "initialize" && symbol.default_export));

        let usage = parse(
            &mut engines,
            "user.ts",
            "typescript",
            "import start from './default';\nstart();",
        );
        assert!(usage
            .refs
            .iter()
            .any(|reference| reference.name == "default"));
    }

    #[test]
    fn records_the_statement_range_for_each_import_edge() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "imports.ts",
            "typescript",
            "// setup\nimport {\n  value,\n} from './store.js';\nvalue();\n",
        );
        let imported = parsed
            .imports
            .iter()
            .find(|imported| imported.specifier == "./store.js")
            .expect("import edge");
        assert_eq!(imported.start_line, 2);
        assert_eq!(imported.end_line, 4);
    }

    #[test]
    fn reports_utf8_byte_columns() {
        let mut engines = Engines::new();
        let source = "/*😀*/ export function run() { return 1; }";
        let parsed = parse(&mut engines, "unicode.ts", "typescript", source);
        let symbol = parsed
            .symbols
            .iter()
            .find(|candidate| candidate.name == "run")
            .expect("run symbol");
        let start = source.find("function").expect("function keyword");
        assert_eq!(symbol.start_column, start as u32);
        assert_eq!(symbol.end_column, source.len() as u32);
    }

    #[test]
    fn excludes_shadowed_typescript_imports() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "shadow.ts",
            "typescript",
            "import { query } from './db';\nfunction run(query: () => void) { query(); }",
        );
        assert!(parsed.refs.is_empty());
    }

    #[test]
    fn respects_javascript_var_hoisting_without_leaking_let_bindings() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "shadow.js",
            "javascript",
            "import { foo } from './db.js';\n\
             function hoisted(flag) { if (flag) { var foo = () => 1; } return foo(); }\n\
             function lexical(flag) { if (flag) { let foo = () => 1; foo(); } return foo(); }",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 1);
        assert_eq!(foo[0].line, 3);
    }

    #[test]
    fn respects_singular_arrow_parameters_and_named_function_expressions() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "shadow.ts",
            "typescript",
            "import { foo } from './db.js';\n\
             const localArrow = foo => foo();\n\
             const importedArrow = value => foo(value);\n\
             const recursive = function foo(value = foo) { return foo(value); };\n\
             const typed = function foo<T extends typeof foo>() { return foo; };",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 1);
        assert_eq!(foo[0].line, 3);
    }

    #[test]
    fn does_not_hoist_var_out_of_abstract_class_static_blocks() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "scope.ts",
            "typescript",
            "import { foo } from './db.js';\n\
             function outer() { abstract class C { static { if (true) { var foo = 1; } consume(foo); } } return foo(); }",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 1);
        assert_eq!(foo[0].line, 2);
    }

    #[test]
    fn hoists_for_var_bindings_to_the_containing_function() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "loop.js",
            "javascript",
            "import { foo } from './db.js';\n\
             function local(values) { foo(); for (var foo of values) { foo(); } return foo; }\n\
             foo();",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 1);
        assert_eq!(foo[0].line, 3);
    }

    #[test]
    fn scopes_for_let_bindings_over_the_loop_and_rhs() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "loop.js",
            "javascript",
            "import { foo } from './db.js';\n\
             function local(values) { for (let foo of values) { foo(); } return foo(); }\n\
             function direct() { for (const foo of foo) { foo(); } return foo(); }\n\
             function destructured() { for (const { foo } of foo) { foo(); } return foo(); }\n\
             function enumerated() { for (let foo in foo) { consume(foo); } return foo; }",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 4);
        assert_eq!(
            foo.iter()
                .map(|reference| reference.line)
                .collect::<Vec<_>>(),
            vec![2, 3, 4, 5]
        );
    }

    #[test]
    fn respects_class_names_as_lexical_bindings() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "classes.ts",
            "typescript",
            "import { foo } from './db.js';\n\
             function declared() { class foo {}; return foo; }\n\
             function abstracted() { abstract class foo {}; return foo; }\n\
             const expression = class foo { method() { return foo; } };",
        );
        assert!(parsed.refs.iter().all(|reference| reference.name != "foo"));
    }

    #[test]
    fn limits_javascript_var_hoisting_to_function_bodies() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "scope.js",
            "javascript",
            "import { foo } from './db.js';\n\
             function defaulted(value = foo) { var foo = 1; return value; }\n\
             class Container { [foo]() { var foo = 1; return foo; } }",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 2);
        assert_eq!(foo[0].line, 2);
        assert_eq!(foo[1].line, 3);
    }

    #[test]
    fn keeps_typescript_parameters_shadowing_imports_in_return_annotations() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "return-types.ts",
            "typescript",
            "import { foo } from './db.js';\n\
             function predicate(foo: unknown): foo is string { return true; }\n\
             function query(foo: string): typeof foo { return foo; }\n\
             function imported(): typeof foo { throw new Error(); }",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 1);
        assert_eq!(foo[0].line, 4);
    }

    #[test]
    fn keeps_javascript_destructuring_reads_out_of_the_var_binding_set() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "pattern.js",
            "javascript",
            "import { foo } from './db.js';\n\
             function run(obj) { var { x = foo, [foo]: y } = obj; return foo(); }\n\
             function shadowed(obj) { var { value: foo } = obj; return foo; }\n\
             function parameter({ x = foo, [foo]: y }) { return foo(); }",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 6);
        assert!(foo
            .iter()
            .all(|reference| reference.line == 2 || reference.line == 4));
    }

    #[test]
    fn keeps_repeated_import_uses_on_the_same_line() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "user.ts",
            "typescript",
            "import { foo } from './lib';\nfoo(); foo();",
        );
        let foo: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.name == "foo")
            .collect();
        assert_eq!(foo.len(), 2);
        assert_ne!(foo[0].column, foo[1].column);
    }

    #[test]
    fn resolves_python_from_import_namespace_members_through_the_child_module() {
        let mut engines = Engines::new();
        for (source, expected_module) in [
            (
                "from . import helpers\ndef run():\n    return helpers.wave()\n",
                ".helpers",
            ),
            (
                "from pkg import helpers as h\ndef run():\n    return h.wave()\n",
                "pkg.helpers",
            ),
        ] {
            let parsed = parse(&mut engines, "pkg/user.py", "python", source);
            assert!(parsed
                .refs
                .iter()
                .any(|reference| reference.name == "wave" && reference.module == expected_module));
        }
    }

    #[test]
    fn respects_python_comprehension_scopes_and_the_outer_iterable() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "user.py",
            "python",
            "from mod import Thing\n\
             items = [1, 2]\n\
             shadowed = [Thing.x for Thing in items]\n\
             imported = [item for item in Thing]",
        );
        let thing: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.module == "mod")
            .collect();
        assert_eq!(thing.len(), 1);
        assert_eq!(thing[0].name, "Thing");
        assert_eq!(thing[0].line, 4);
    }

    #[test]
    fn keeps_python_comprehension_target_reads() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "user.py",
            "python",
            "from mod import obj, key\n\
             values = [obj for obj[key] in items]",
        );
        let obj: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.module == "mod" && reference.name == "obj")
            .collect();
        assert_eq!(obj.len(), 2);
        assert!(parsed
            .refs
            .iter()
            .any(|reference| reference.module == "mod" && reference.name == "key"));
    }

    #[test]
    fn does_not_treat_a_python_class_namespace_as_a_method_closure() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "user.py",
            "python",
            r#"from mod import Thing
class Container:
    Thing = 1
    def make(self):
        return Thing()"#,
        );
        let thing: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.module == "mod" && reference.name == "Thing")
            .collect();
        assert_eq!(thing.len(), 1);
        assert_eq!(thing[0].line, 5);
    }

    #[test]
    fn resolves_python_class_headers_before_their_local_namespace() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "user.py",
            "python",
            r#"from mod import Thing
class Container(Thing):
    Thing = 1
    class Nested(Thing):
        pass"#,
        );
        let thing: Vec<&Reference> = parsed
            .refs
            .iter()
            .filter(|reference| reference.module == "mod" && reference.name == "Thing")
            .collect();
        assert_eq!(thing.len(), 1);
        assert_eq!(thing[0].line, 2);
    }

    #[test]
    fn structural_search_stops_at_the_requested_cap() {
        let hits = search(
            "many.ts",
            "typescript",
            "const a = 1; const b = 2; const c = 3; const d = 4;",
            "(identifier) @id",
            None,
            2,
        );
        assert_eq!(hits.len(), 2);
    }
}

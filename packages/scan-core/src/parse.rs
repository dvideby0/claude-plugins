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

#[derive(Default)]
pub struct Parsed {
    pub symbols: Vec<Symbol>,
    pub imports: Vec<String>,
    pub refs: Vec<Reference>,
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
                                &module,
                                &exported,
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

fn pattern_binds(node: Node, name: &str, bytes: &[u8]) -> bool {
    if node.kind() == "identifier" {
        return node.utf8_text(bytes).is_ok_and(|value| value == name);
    }
    // Assigning `object.name` or `items[name]` does not create a lexical name.
    if matches!(
        node.kind(),
        "attribute" | "subscript" | "member_expression" | "subscript_expression"
    ) {
        return false;
    }
    let mut cursor = node.walk();
    let found = node
        .named_children(&mut cursor)
        .any(|child| pattern_binds(child, name, bytes));
    found
}

fn field_binds(node: Node, field: &str, name: &str, bytes: &[u8]) -> bool {
    node.child_by_field_name(field)
        .is_some_and(|target| pattern_binds(target, name, bytes))
}

fn within(node: Node, container: Node) -> bool {
    container.start_byte() <= node.start_byte() && node.end_byte() <= container.end_byte()
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
            "assignment" | "augmented_assignment" | "for_statement" => return in_field("left"),
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
        if matches!(
            scope.kind(),
            "function_definition" | "lambda" | "class_definition" | "module"
        ) {
            if scope.start_byte() == binding.scope_start && scope.end_byte() == binding.scope_end {
                return false;
            }

            // Defaults and annotations execute outside the new function scope.
            let inside_parameters = scope
                .child_by_field_name("parameters")
                .is_some_and(|params| {
                    params.start_byte() <= node.start_byte() && node.end_byte() <= params.end_byte()
                });
            if !inside_parameters
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

fn typescript_binding_occurrence(node: Node) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        let in_field = |field: &str| {
            parent
                .child_by_field_name(field)
                .is_some_and(|target| within(node, target))
        };
        match parent.kind() {
            "variable_declarator" => return in_field("name"),
            "required_parameter" | "optional_parameter" => {
                return in_field("pattern") || in_field("name")
            }
            "function_declaration"
            | "generator_function_declaration"
            | "class_declaration" => return in_field("name"),
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

fn typescript_scope_binds(scope: Node, name: &str, bytes: &[u8]) -> bool {
    if scope
        .child_by_field_name("parameters")
        .is_some_and(|parameters| typescript_parameters_bind(parameters, name, bytes))
    {
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
                    | "class"
                    | "statement_block"
                    | "catch_clause"
            )
        {
            // A declaration name belongs to the surrounding block; its body
            // and parameters belong to the nested scope.
            return matches!(
                node.kind(),
                "function_declaration" | "generator_function_declaration" | "class_declaration"
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

/** Whether a TypeScript/JavaScript scope nested inside the import shadows it. */
fn typescript_shadowed(node: Node, binding: &Binding, bytes: &[u8]) -> bool {
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
                | "class_declaration"
                | "class"
                | "statement_block"
                | "catch_clause"
                | "program"
        ) {
            if scope.start_byte() == binding.scope_start && scope.end_byte() == binding.scope_end {
                return false;
            }
            if typescript_scope_binds(scope, &binding.local, bytes) {
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
                            Grammar::Typescript | Grammar::Tsx => {
                                typescript_shadowed(node, binding, bytes)
                            }
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
    let mut imports: Vec<String> = Vec::new();
    let mut seen_imports = std::collections::HashSet::new();

    let mut push_import = |value: &str| {
        let trimmed = value.trim();
        if !trimmed.is_empty() && seen_imports.insert(trimmed.to_string()) {
            imports.push(trimmed.to_string());
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
            if let Some(source_node) = node.child_by_field_name("source") {
                if let Ok(text) = source_node.utf8_text(bytes) {
                    push_import(strip_quotes(text));
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
                                push_import(text);
                            }
                        }
                        "aliased_import" => {
                            if let Some(target) = child.child_by_field_name("name") {
                                if let Ok(text) = target.utf8_text(bytes) {
                                    push_import(text);
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
                    push_import(text);
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
        });
    }

    let refs = collect_refs(tree.root_node(), bytes, &bindings, grammar);
    Parsed {
        symbols,
        imports,
        refs,
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
        assert!(usage.refs.iter().any(|reference| reference.name == "default"));
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
                .any(|reference| reference.name == "wave"
                    && reference.module == expected_module));
        }
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

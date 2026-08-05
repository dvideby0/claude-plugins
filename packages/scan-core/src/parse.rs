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
    pub end_line: u32,
    pub exported: bool,
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
    /// Python's unaliased `import pkg.db` binds `pkg`, but a useful exported
    /// symbol appears only after the full `pkg.db` qualifier in a use.
    module_path_bound: bool,
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

/// Names bound by one `import` statement.
///
/// Walked rather than queried: the shapes differ enough between default,
/// named, aliased and namespace imports that a query per case would be longer
/// than the walk, and this has to handle all of them to resolve usages.
fn bindings_from_import(node: Node, bytes: &[u8], grammar: Grammar, out: &mut Vec<Binding>) {
    let text = |n: Node| n.utf8_text(bytes).unwrap_or("").to_string();

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
                                module_path_bound: true,
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
                                module_path_bound: false,
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
                            exported: name,
                            module: module.clone(),
                            module_path_bound: false,
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
                            exported,
                            module: module.clone(),
                            module_path_bound: false,
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
                    module_path_bound: false,
                }),
                // `import * as ns from "m"`
                "namespace_import" => {
                    if let Some(alias) = part.child(part.child_count().saturating_sub(1)) {
                        out.push(Binding {
                            local: text(alias),
                            exported: "*".to_string(),
                            module: module.clone(),
                            module_path_bound: false,
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
                                module_path_bound: false,
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

fn collect_refs(root: Node, bytes: &[u8], bindings: &[Binding]) -> Vec<Reference> {
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
            if node.kind() == "identifier" && !is_member_property(node) {
                if let Ok(text) = node.utf8_text(bytes) {
                    if let Some(binding) = bindings.iter().find(|b| b.local == text) {
                        let line = node.start_position().row as u32 + 1;
                        let name = if binding.exported == "*" {
                            namespace_member(node, binding, bytes)
                                .unwrap_or_else(|| binding.exported.clone())
                        } else {
                            binding.exported.clone()
                        };
                        if seen.insert((name.clone(), binding.module.clone(), line)) {
                            refs.push(Reference {
                                name,
                                module: binding.module.clone(),
                                line,
                            });
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
pub fn search(path: &str, lang: &str, source: &str, query_source: &str) -> Vec<Hit> {
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
        let end_line = node.end_position().row as u32 + 1;

        if label == "variable" {
            let value_kind = node
                .child_by_field_name("value")
                .map(|v| v.kind().to_string())
                .unwrap_or_default();

            let callable = matches!(
                value_kind.as_str(),
                "arrow_function" | "function_expression" | "function" | "class"
            );
            let exported = is_exported_ts(node);

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
                    end_line,
                    exported,
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
                    end_line,
                    exported: true,
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

        let exported = if grammar == Grammar::Python {
            !name.starts_with('_')
        } else {
            is_exported_ts(node)
        };

        symbols.push(Symbol {
            kind,
            name: name.to_string(),
            start_line,
            end_line,
            exported,
            signature: first_line(text),
        });
    }

    let refs = collect_refs(tree.root_node(), bytes, &bindings);
    Parsed {
        symbols,
        imports,
        refs,
    }
}

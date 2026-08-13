//! Signatures that separate a change in meaning from a change in bytes.
//!
//! A content hash cannot tell a renamed parameter from a reformatted comment,
//! so every edit invalidated everything anchored to the file: components
//! drifted, flow steps went stale, memories needed re-checking. Re-drawing a
//! map is expensive, and paying that for a typo fix trains people to ignore
//! staleness altogether.
//!
//! Three signatures, each answering a different question:
//!
//! - **syntax** — did the code change at all, ignoring comments and layout?
//! - **interface** — did a symbol's contract change, so callers may care?
//! - **body** — did only its implementation change?
//!
//! What deliberately keeps using the content hash: anything anchored to a line
//! range. Inserting a comment really does move a finding's lines, and reporting
//! a stale line number as current is a worse failure than over-invalidating,
//! because it is silent.

use crate::parse::Grammar;
use sha2::{Digest, Sha256};
use tree_sitter::Node;

/// Marks a node the grammar could not parse, so a broken file stays
/// distinguishable from a clean one that happens to hash the same.
const ERROR_MARKER: &[u8] = b"\x01?";

/// The crate's one convention for turning a digest into a stored signature:
/// lowercase hex, truncated to 16 characters. Shared so a second hash cannot
/// pick a different width and make two stored signatures incomparable.
pub(crate) fn finish(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .chars()
        .take(16)
        .collect()
}

/// Hash the shape of a subtree: node kinds, nesting, and leaf text.
///
/// Comments and line continuations are grammar *extras* in both
/// tree-sitter-typescript and tree-sitter-python, so `is_extra` removes them
/// wholesale; whitespace never produces a node at all.
///
/// Interior nodes and their boundaries are hashed, not just leaves. A leaf
/// stream alone loses real structure: moving a Python statement out of an
/// indented block leaves the token sequence identical while changing what the
/// code does, and `return\nvalue` parses differently from `return value` in
/// TypeScript for the same tokens. Both would have hashed the same and left
/// every artifact anchored to the file reading as current.
///
/// `skip` prunes one subtree by id, which is how an interface signature
/// excludes its own body without needing a field list per node kind.
///
/// `grammar` decides whether the Python docstring rule applies. It is threaded
/// rather than inferred from node kinds because the shapes collide: `module` is
/// also a tree-sitter-typescript kind, and a TypeScript directive prologue
/// (`"use strict"`, `"use client"`) is likewise a string expression statement at
/// the top of its enclosing block. Those are instructions to the compiler and
/// the server, so a rule generalised across grammars by shape alone would make
/// them invisible to every artifact anchored to the file.
fn hash_tokens(root: Node, bytes: &[u8], skip: Option<usize>, grammar: Grammar, hasher: &mut Sha256) {
    enum Step<'tree> {
        Enter(Node<'tree>),
        /// Closing a node, so nesting depth is part of the hash rather than
        /// flattened away.
        Exit,
    }

    // An explicit stack rather than recursion: a deeply nested generated file
    // should not be able to overflow the scan thread.
    let mut stack = vec![Step::Enter(root)];
    while let Some(step) = stack.pop() {
        let node = match step {
            Step::Exit => {
                hasher.update(b")");
                continue;
            }
            Step::Enter(node) => node,
        };

        if skip == Some(node.id()) || (node.is_extra() && !semantic_extra(node, bytes)) {
            continue;
        }
        // Skipped whole, the way `is_extra` drops a comment: a docstring is
        // Python's comment, and its statement wrapper carries nothing else.
        if grammar == Grammar::Python && python_docstring(node, bytes) {
            continue;
        }
        if node.is_error() || node.is_missing() {
            hasher.update(ERROR_MARKER);
        }

        hasher.update(node.kind().as_bytes());
        let children = node.child_count();
        if children == 0 {
            hasher.update(b"\0");
            // An anonymous leaf's kind *is* its text (`{`, `=>`, `,`), so only
            // named leaves need the source slice.
            if node.is_named() {
                if let Ok(text) = node.utf8_text(bytes) {
                    hasher.update(text.as_bytes());
                }
            }
            hasher.update(b"\n");
            continue;
        }

        hasher.update(b"(");
        stack.push(Step::Exit);
        for index in (0..children).rev() {
            if let Some(child) = node.child(index) {
                stack.push(Step::Enter(child));
            }
        }
    }
}

/// Comments the toolchain reads as instructions rather than prose.
///
/// Most comments are for people and changing them changes nothing. These are
/// not: they switch type checking off, pull in type declarations, or tell a
/// bundler what it may drop. Treating them as prose would let a real behaviour
/// change slip past every artifact anchored to the file.
fn semantic_extra(node: Node, bytes: &[u8]) -> bool {
    let Ok(text) = node.utf8_text(bytes) else {
        return false;
    };
    let trimmed = text.trim_start();
    trimmed.starts_with("///")
        || text.contains("@ts-")
        || text.contains("@jsx")
        || text.contains("@flow")
        || text.contains("@__PURE__")
        || text.contains("webpack")
        || text.contains("vite-ignore")
        || text.contains("eslint")
        || text.contains("type: ignore")
        || text.contains("noqa")
}

/// A `str` constant in one of the three positions Python assigns to `__doc__`.
///
/// This is prose in the same sense a comment is, so it is dropped for the same
/// reason. The rule is deliberately narrow, because a string is an ordinary
/// value everywhere else and dropping one that carries meaning would report a
/// real change as no change — the silent direction:
///
/// - the statement holds exactly one `string` and nothing else;
/// - it sits directly under `module`, or under the `block` of a
///   `function_definition` or `class_definition`;
/// - it is that parent's first statement, ignoring comments, because Python
///   only binds `__doc__` from the first one;
/// - the literal is a real `str` — an f-string executes code and a `bytes`
///   literal does not become `__doc__` at all.
///
/// Two limits are deliberate and pinned by tests rather than left to be
/// rediscovered: an implicitly concatenated docstring (`"a" "b"`) keeps being
/// hashed, and a Sphinx attribute docstring is not a docstring here because
/// Python does not make it one.
fn python_docstring(node: Node, bytes: &[u8]) -> bool {
    if node.kind() != "expression_statement" {
        return false;
    }

    let mut cursor = node.walk();
    let mut statements = node.named_children(&mut cursor).filter(|child| !child.is_extra());
    let Some(literal) = statements.next() else {
        return false;
    };
    if statements.next().is_some() || literal.kind() != "string" || !plain_str(literal, bytes) {
        return false;
    }

    let Some(parent) = node.parent() else {
        return false;
    };
    let bound_to_doc = match parent.kind() {
        "module" => true,
        "block" => matches!(
            parent.parent().map(|owner| owner.kind()),
            Some("function_definition" | "class_definition")
        ),
        _ => false,
    };
    if !bound_to_doc || !is_first_statement(parent, node) {
        return false;
    }

    // A doctest is executable: `pytest --doctest-modules` runs it, and
    // `doctest.testmod` is a supported way to ship tests. Same reasoning as
    // `semantic_extra` — an instruction is not prose, whatever it looks like.
    literal
        .utf8_text(bytes)
        .map_or(false, |text| !text.contains(">>>"))
}

/// A `str` literal with no prefix that changes what it is.
///
/// `r`/`u` still produce a `str`, so they stay prose. `f` executes the
/// expressions inside it and `b` produces bytes, which Python never binds to
/// `__doc__`. The `interpolation` child is checked as well as the prefix so an
/// f-string is caught from either direction.
fn plain_str(literal: Node, bytes: &[u8]) -> bool {
    let mut cursor = literal.walk();
    for child in literal.children(&mut cursor) {
        match child.kind() {
            "interpolation" => return false,
            "string_start" => {
                let Ok(text) = child.utf8_text(bytes) else {
                    return false;
                };
                let prefix = text.trim_end_matches(['"', '\'']);
                if !prefix.chars().all(|mark| matches!(mark, 'r' | 'R' | 'u' | 'U')) {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

/// Whether `node` is the first thing `parent` actually executes.
///
/// Comments are named *and* extra in tree-sitter, so "first named child" would
/// let a commented file take a different path from an uncommented one.
fn is_first_statement(parent: Node, node: Node) -> bool {
    let mut cursor = parent.walk();
    let first = parent
        .named_children(&mut cursor)
        .find(|child| !child.is_extra());
    first.is_some_and(|first| first.id() == node.id())
}

/// The file's meaning, invariant to comments and formatting.
pub fn file_syntax_sha(root: Node, bytes: &[u8], grammar: Grammar) -> String {
    let mut hasher = Sha256::new();
    hash_tokens(root, bytes, None, grammar, &mut hasher);
    finish(hasher)
}

/// Declarations whose body *is* their contract.
///
/// An interface's members, an enum's variants and a class's shape are what a
/// caller depends on, so excluding the body for these would let a property,
/// variant or public method change while the symbol's interface signature
/// stayed identical — and every component depending on it would read clean.
///
/// For a class this deliberately over-invalidates: editing a private method
/// body moves the class's interface signature too. Its methods also carry
/// their own signatures, so the precision is available where it matters, and
/// reporting a changed contract as unchanged is the failure worth avoiding.
fn body_is_contract(kind: &str) -> bool {
    matches!(
        kind,
        "interface_declaration"
            | "enum_declaration"
            | "class_declaration"
            | "class_definition"
            | "abstract_class_declaration"
            | "object_type"
    )
}

/// The subtree holding a declaration's implementation, if it has one.
///
/// `const handler = () => {…}` keeps its body under the assigned expression
/// rather than a `body` field, so a callable value is followed one step. A
/// non-callable value is deliberately *not* a body: for an exported constant
/// the values are the contract, and hiding them in the body signature would
/// let a union change without any caller being told.
fn body_node<'tree>(node: Node<'tree>) -> Option<Node<'tree>> {
    if body_is_contract(node.kind()) {
        return None;
    }
    if let Some(body) = node.child_by_field_name("body") {
        return Some(body);
    }
    let value = node.child_by_field_name("value")?;
    if !matches!(
        value.kind(),
        "arrow_function" | "function_expression" | "function" | "class"
    ) {
        return None;
    }
    value.child_by_field_name("body").or(Some(value))
}

/// Fold visibility into a declaration's contract.
///
/// `export function f` and `function f` produce identical declaration nodes —
/// the `export` keyword belongs to the statement wrapping them. Without this,
/// withdrawing an export left the interface signature unchanged even though
/// the import contract had disappeared entirely.
pub fn interface_with_visibility(interface: &str, exported: bool, default_export: bool) -> String {
    let mut hasher = Sha256::new();
    hasher.update(interface.as_bytes());
    hasher.update(b"\0");
    hasher.update(if exported { b"export" as &[u8] } else { b"local" });
    hasher.update(b"\0");
    hasher.update(if default_export { b"default" as &[u8] } else { b"named" });
    finish(hasher)
}

/// What a caller depends on, and what only the implementation depends on.
///
/// The split is one rule rather than a field list per node kind: the interface
/// is every token of the declaration *except* its body, so it picks up the
/// name, modifiers, type parameters, parameters, return type and heritage
/// clause without the extraction needing to know which grammar produced them.
///
/// A declaration with no body — an interface, a type alias, an enum, an
/// exported constant — hashes whole, because for those the body *is* the
/// contract. Its body signature is `None`; a signature that does not apply is
/// recorded as absent, never as an invented hash.
pub fn symbol_signatures(node: Node, bytes: &[u8], grammar: Grammar) -> (String, Option<String>) {
    let body = body_node(node);

    let mut interface = Sha256::new();
    hash_tokens(node, bytes, body.map(|child| child.id()), grammar, &mut interface);

    let body_sha = body.map(|child| {
        let mut hasher = Sha256::new();
        hash_tokens(child, bytes, None, grammar, &mut hasher);
        finish(hasher)
    });

    (finish(interface), body_sha)
}

/// The set of modules and imported names this file depends on.
///
/// Sorted, so a reordered import block is not a change. Recorded now and not
/// yet acted on: skipping the whole-repository edge re-resolution it would
/// enable is a real win but a real correctness risk, and deserves its own
/// change with its own measurement.
pub fn relation_set_sha(imports: &[crate::parse::Import], refs: &[crate::parse::Reference]) -> String {
    let mut specifiers: Vec<&str> = imports.iter().map(|item| item.specifier.as_str()).collect();
    specifiers.sort_unstable();
    specifiers.dedup();

    let mut uses: Vec<(&str, &str)> = refs
        .iter()
        .map(|item| (item.module.as_str(), item.name.as_str()))
        .collect();
    uses.sort_unstable();
    uses.dedup();

    let mut hasher = Sha256::new();
    for specifier in specifiers {
        hasher.update(specifier.as_bytes());
        hasher.update(b"\n");
    }
    hasher.update(b"\0");
    for (module, name) in uses {
        hasher.update(module.as_bytes());
        hasher.update(b"\0");
        hasher.update(name.as_bytes());
        hasher.update(b"\n");
    }
    finish(hasher)
}

/// Identity for a symbol that survives cosmetic edits.
///
/// `symbols.id` embeds the declaration's line and column, so inserting a
/// comment above a function gives it a different id and no cross-scan
/// comparison is possible. The ordinal disambiguates same-named declarations
/// in one file and only moves when that duplicate set itself changes.
pub fn symbol_key(path: &str, kind: &str, name: &str, scope: &str, ordinal: u32) -> String {
    if scope.is_empty() {
        format!("{path}#{kind}:{name}#{ordinal}")
    } else {
        format!("{path}#{scope}.{kind}:{name}#{ordinal}")
    }
}

#[cfg(test)]
mod tests {
    use crate::parse::{parse, Engines};

    fn syntax(source: &str) -> String {
        let mut engines = Engines::new();
        parse(&mut engines, "src/app.ts", "typescript", source).syntax_sha
    }

    fn python_syntax(source: &str) -> String {
        let mut engines = Engines::new();
        parse(&mut engines, "app.py", "python", source).syntax_sha
    }

    fn python_interface_of(source: &str, name: &str) -> (String, Option<String>) {
        let mut engines = Engines::new();
        let parsed = parse(&mut engines, "app.py", "python", source);
        let symbol = parsed
            .symbols
            .into_iter()
            .find(|symbol| symbol.name == name)
            .expect("symbol is extracted");
        (symbol.interface_sha, symbol.body_sha)
    }

    fn interface_of(source: &str, name: &str) -> (String, Option<String>) {
        let mut engines = Engines::new();
        let parsed = parse(&mut engines, "src/app.ts", "typescript", source);
        let symbol = parsed
            .symbols
            .into_iter()
            .find(|symbol| symbol.name == name)
            .expect("symbol is extracted");
        (symbol.interface_sha, symbol.body_sha)
    }

    #[test]
    fn comments_and_formatting_do_not_move_the_syntax_signature() {
        let plain = syntax("export function run(value: string) {\n  return value;\n}\n");
        let commented = syntax(
            "/** Explains itself at length. */\n// and again\nexport function run(value: string) {\n  // inside\n  return value;\n}\n",
        );
        let reformatted =
            syntax("export function run(value: string)\n{\n        return value;\n}\n\n\n");

        assert_eq!(plain, commented);
        assert_eq!(plain, reformatted);
    }

    #[test]
    fn a_real_edit_moves_the_syntax_signature() {
        let before = syntax("export function run(value: string) {\n  return value;\n}\n");
        let renamed = syntax("export function run(input: string) {\n  return input;\n}\n");
        let reordered = syntax(
            "export function b() {\n  return 2;\n}\nexport function a() {\n  return 1;\n}\n",
        );
        let original_order = syntax(
            "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n",
        );

        assert_ne!(before, renamed);
        assert_ne!(reordered, original_order);
    }

    #[test]
    fn structure_is_part_of_the_syntax_signature() {
        // Same tokens, different parse. Hashing only leaves would report both
        // of these as unchanged while the code does something else entirely.
        let inside = python_syntax("def run(flag):\n    if flag:\n        step()\n        done()\n");
        let outside = python_syntax("def run(flag):\n    if flag:\n        step()\n    done()\n");
        assert_ne!(inside, outside);

        // TypeScript's automatic semicolon insertion makes this a real
        // behaviour change for an identical token sequence.
        let returned = syntax("export function run() {\n  return value;\n}\n");
        let separated = syntax("export function run() {\n  return\n  value;\n}\n");
        assert_ne!(returned, separated);
    }

    #[test]
    fn directive_comments_are_hashed_but_prose_is_not() {
        let plain = syntax("export const value: string = 1 as never;\n");
        let prose = syntax("// somebody explaining themselves\nexport const value: string = 1 as never;\n");
        assert_eq!(plain, prose);

        // These switch type checking off, pull in declarations, or tell a
        // bundler what it may drop. They are instructions, not prose.
        for directive in [
            "// @ts-nocheck\n",
            "/// <reference types=\"node\" />\n",
            "/* webpackIgnore: true */\n",
        ] {
            assert_ne!(
                plain,
                syntax(&format!("{directive}export const value: string = 1 as never;\n")),
                "{directive} changes how the file is compiled",
            );
        }
    }

    #[test]
    fn an_aggregate_declarations_members_are_its_contract() {
        // Excluding the body here would let a property, variant or public
        // method change while the symbol still reported an identical contract.
        let (before, body) = interface_of("export interface Order {\n  id: string;\n}\n", "Order");
        assert!(body.is_none());
        let (added, _) =
            interface_of("export interface Order {\n  id: string;\n  total: number;\n}\n", "Order");
        assert_ne!(before, added);

        let (enum_before, _) = interface_of("export enum Mode {\n  Fast,\n}\n", "Mode");
        let (enum_after, _) = interface_of("export enum Mode {\n  Fast,\n  Slow,\n}\n", "Mode");
        assert_ne!(enum_before, enum_after);

        let (class_before, _) =
            interface_of("export class Cart {\n  add(item: string) {}\n}\n", "Cart");
        let (class_after, _) =
            interface_of("export class Cart {\n  add(item: string, qty: number) {}\n}\n", "Cart");
        assert_ne!(class_before, class_after);
    }

    #[test]
    fn withdrawing_an_export_moves_the_interface_signature() {
        // The `export` keyword belongs to the statement wrapping the
        // declaration, so the declaration nodes are identical. The import
        // contract is not.
        let (exported, _) = interface_of("export function run() {\n  return 1;\n}\n", "run");
        let (local, _) = interface_of("function run() {\n  return 1;\n}\n", "run");
        assert_ne!(exported, local);
    }

    #[test]
    fn a_broken_parse_is_distinguishable_from_a_clean_one() {
        let clean = syntax("export const value = 1;\n");
        let broken = syntax("export const value = ;\n");
        assert_ne!(clean, broken);
    }

    #[test]
    fn python_comments_and_docstrings_are_both_prose() {
        let plain = python_syntax("def run(value):\n    return value\n");
        let commented = python_syntax("# explains itself\ndef run(value):\n    # inside\n    return value\n");
        assert_eq!(plain, commented);

        // A docstring is not a comment to the grammar, but it is one to a
        // reader: Python's own convention puts the prose inside the code.
        let documented = python_syntax("def run(value):\n    \"\"\"Explains itself.\"\"\"\n    return value\n");
        let redocumented =
            python_syntax("def run(value):\n    \"\"\"Explains itself differently.\"\"\"\n    return value\n");
        assert_eq!(plain, documented);
        assert_eq!(documented, redocumented);

        // Every position Python binds `__doc__` from, including an added one.
        let module = python_syntax("\"\"\"The module.\"\"\"\ndef run(value):\n    return value\n");
        assert_eq!(plain, module);

        let bare_class = python_syntax("class Cart:\n    def add(self, item):\n        return item\n");
        let documented_class = python_syntax(
            "class Cart:\n    \"\"\"A cart.\"\"\"\n    def add(self, item):\n        \"\"\"Adds.\"\"\"\n        return item\n",
        );
        assert_eq!(bare_class, documented_class);

        let bare_async = python_syntax("async def run(value):\n    return value\n");
        let documented_async =
            python_syntax("async def run(value):\n    \"\"\"Explains itself.\"\"\"\n    return value\n");
        assert_eq!(bare_async, documented_async);
    }

    #[test]
    fn a_real_python_edit_still_moves_the_signature() {
        // The control. Without this, a docstring rule that skipped too much
        // would pass every assertion above and prove only that hashing broke.
        let before = python_syntax("def run(value):\n    \"\"\"Explains itself.\"\"\"\n    return value\n");
        let after =
            python_syntax("def run(value):\n    \"\"\"Explains itself.\"\"\"\n    return value.strip()\n");
        assert_ne!(before, after);
    }

    #[test]
    fn a_python_string_that_is_not_a_docstring_stays_hashed() {
        // A value, not prose.
        let assigned = python_syntax("def run():\n    x = \"a\"\n    return x\n");
        let reassigned = python_syntax("def run():\n    x = \"b\"\n    return x\n");
        assert_ne!(assigned, reassigned);

        // Not the first statement, so Python does not bind it to `__doc__`.
        let trailing = python_syntax("def run():\n    step()\n    \"note\"\n");
        let retrailed = python_syntax("def run():\n    step()\n    \"other\"\n");
        assert_ne!(trailing, retrailed);

        // A block that belongs to a statement, not to a definition.
        let branch = python_syntax("def run(flag):\n    if flag:\n        \"note\"\n");
        let rebranched = python_syntax("def run(flag):\n    if flag:\n        \"other\"\n");
        assert_ne!(branch, rebranched);

        // Sphinx attribute docs read like documentation but Python does not
        // make them `__doc__`. Deliberately out of scope, pinned so it stays a
        // known limit.
        let attribute = python_syntax("X = 1\n\"\"\"Documents X.\"\"\"\n");
        let reattributed = python_syntax("X = 1\n\"\"\"Documents X differently.\"\"\"\n");
        assert_ne!(attribute, reattributed);

        // Implicit concatenation is the conservative limit: still hashed.
        let joined = python_syntax("def run():\n    \"a\" \"b\"\n    return 1\n");
        let rejoined = python_syntax("def run():\n    \"a\" \"c\"\n    return 1\n");
        assert_ne!(joined, rejoined);
    }

    #[test]
    fn a_python_literal_that_executes_or_is_not_str_stays_hashed() {
        // An f-string in docstring position runs code and leaves `__doc__`
        // as None; bytes never becomes `__doc__` at all.
        let interpolated = python_syntax("def run():\n    f\"{compute()}\"\n    return 1\n");
        let reinterpolated = python_syntax("def run():\n    f\"{other()}\"\n    return 1\n");
        assert_ne!(interpolated, reinterpolated);

        // No placeholders, so the prefix is the only signal left.
        let flat = python_syntax("def run():\n    f\"plain\"\n    return 1\n");
        let reflat = python_syntax("def run():\n    f\"other\"\n    return 1\n");
        assert_ne!(flat, reflat);

        let raw_bytes = python_syntax("def run():\n    b\"payload\"\n    return 1\n");
        let other_bytes = python_syntax("def run():\n    b\"other\"\n    return 1\n");
        assert_ne!(raw_bytes, other_bytes);

        // `r` and `u` still produce a `str`, so they are still prose.
        let raw = python_syntax("def run():\n    r\"\"\"Explains itself.\"\"\"\n    return 1\n");
        let reraw = python_syntax("def run():\n    r\"\"\"Explains differently.\"\"\"\n    return 1\n");
        assert_eq!(raw, reraw);
    }

    #[test]
    fn a_doctest_is_an_instruction_not_prose() {
        // `pytest --doctest-modules` executes this. Same rule as `@ts-nocheck`:
        // an instruction is hashed however much it looks like prose.
        let before = python_syntax("def add(a, b):\n    \"\"\"Adds.\n\n    >>> add(1, 1)\n    2\n    \"\"\"\n    return a + b\n");
        let after = python_syntax("def add(a, b):\n    \"\"\"Adds.\n\n    >>> add(1, 2)\n    3\n    \"\"\"\n    return a + b\n");
        assert_ne!(before, after);
    }

    #[test]
    fn a_typescript_directive_prologue_is_not_a_docstring() {
        // Shape-identical to a Python module docstring: a string expression
        // statement first in its block. It changes where the module runs, so
        // this is the test that stops the rule being generalised by shape.
        let client = syntax("\"use client\";\nexport const value = 1;\n");
        let server = syntax("\"use server\";\nexport const value = 1;\n");
        let plain = syntax("export const value = 1;\n");
        assert_ne!(client, server);
        assert_ne!(client, plain);

        let strict = syntax("export function run() {\n  \"use strict\";\n  return 1;\n}\n");
        let loose = syntax("export function run() {\n  return 1;\n}\n");
        assert_ne!(strict, loose);
    }

    #[test]
    fn a_python_method_docstring_does_not_move_its_class_contract() {
        // `body_is_contract` hashes a whole class, so a docstring anywhere
        // inside it reaches the class's interface signature — and from there
        // every component drawn against that class.
        let before = python_interface_of(
            "class Cart:\n    \"\"\"A cart.\"\"\"\n    def add(self, item):\n        \"\"\"Adds an item.\"\"\"\n        return item\n",
            "Cart",
        );
        let redocumented = python_interface_of(
            "class Cart:\n    \"\"\"A shopping cart.\"\"\"\n    def add(self, item):\n        \"\"\"Adds one item.\"\"\"\n        return item\n",
            "Cart",
        );
        assert_eq!(before.0, redocumented.0);

        let resigned = python_interface_of(
            "class Cart:\n    \"\"\"A cart.\"\"\"\n    def add(self, item, quantity):\n        \"\"\"Adds an item.\"\"\"\n        return item\n",
            "Cart",
        );
        assert_ne!(before.0, resigned.0);
    }

    #[test]
    fn an_edit_inside_a_body_moves_only_the_body_signature() {
        let (before_interface, before_body) =
            interface_of("export function run(value: string) {\n  return value;\n}\n", "run");
        let (after_interface, after_body) = interface_of(
            "export function run(value: string) {\n  const trimmed = value.trim();\n  return trimmed;\n}\n",
            "run",
        );

        assert_eq!(before_interface, after_interface);
        assert_ne!(before_body, after_body);
    }

    #[test]
    fn changing_a_parameter_moves_the_interface_signature() {
        let (before, _) = interface_of("export function run(value: string) {\n  return value;\n}\n", "run");
        let (renamed, _) = interface_of("export function run(input: string) {\n  return input;\n}\n", "run");
        let (retyped, _) = interface_of("export function run(value: number) {\n  return value;\n}\n", "run");
        let (added, _) = interface_of(
            "export function run(value: string, salt: string) {\n  return value;\n}\n",
            "run",
        );

        assert_ne!(before, renamed);
        assert_ne!(before, retyped);
        assert_ne!(before, added);
    }

    #[test]
    fn a_declaration_without_a_body_records_no_body_signature() {
        // Its values are its contract, so the whole declaration is the
        // interface. An absent signature is recorded as absent, not invented.
        let (interface, body) =
            interface_of("export const MODES = [\"fast\", \"slow\"] as const;\n", "MODES");
        assert!(body.is_none());
        assert!(!interface.is_empty());

        let (changed, _) =
            interface_of("export const MODES = [\"fast\", \"slow\", \"off\"] as const;\n", "MODES");
        assert_ne!(interface, changed);
    }

    #[test]
    fn symbol_keys_are_stable_when_a_comment_shifts_a_declaration() {
        let mut engines = Engines::new();
        let plain = parse(
            &mut engines,
            "src/app.ts",
            "typescript",
            "export function run() {\n  return 1;\n}\n",
        );
        let shifted = parse(
            &mut engines,
            "src/app.ts",
            "typescript",
            "// a new note\n// and another\nexport function run() {\n  return 1;\n}\n",
        );

        assert_eq!(plain.symbols[0].symbol_key, shifted.symbols[0].symbol_key);
        // The declaration really did move, so its positional identity changed.
        assert_ne!(plain.symbols[0].start_line, shifted.symbols[0].start_line);
    }

    #[test]
    fn duplicate_names_in_one_file_get_distinct_stable_keys() {
        let mut engines = Engines::new();
        let parsed = parse(
            &mut engines,
            "src/app.ts",
            "typescript",
            "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n",
        );
        let keys: Vec<&str> = parsed
            .symbols
            .iter()
            .filter(|symbol| symbol.name == "run")
            .map(|symbol| symbol.symbol_key.as_str())
            .collect();

        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
    }

    #[test]
    fn a_method_key_survives_a_new_method_in_an_earlier_class() {
        // With a global ordinal, inserting `run` into class A renumbers class
        // B's `run` — and a recorded dependency then silently starts tracking
        // a different method while reporting itself unchanged.
        let mut engines = Engines::new();
        let key_of = |engines: &mut Engines, source: &str| {
            parse(engines, "src/app.ts", "typescript", source)
                .symbols
                .into_iter()
                .find(|symbol| symbol.name == "run" && symbol.scope == "B")
                .expect("B.run is extracted")
                .symbol_key
        };

        let before = key_of(&mut engines, "class A {\n}\nclass B {\n  run() {}\n}\n");
        let after = key_of(
            &mut engines,
            "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n",
        );
        assert_eq!(before, after);
    }

    #[test]
    fn reordering_imports_does_not_move_the_relation_set_signature() {
        let mut engines = Engines::new();
        let first = parse(
            &mut engines,
            "src/app.ts",
            "typescript",
            "import { a } from \"./a\";\nimport { b } from \"./b\";\nexport const use = [a, b];\n",
        );
        let swapped = parse(
            &mut engines,
            "src/app.ts",
            "typescript",
            "import { b } from \"./b\";\nimport { a } from \"./a\";\nexport const use = [a, b];\n",
        );
        let extra = parse(
            &mut engines,
            "src/app.ts",
            "typescript",
            "import { a } from \"./a\";\nimport { c } from \"./c\";\nexport const use = [a, c];\n",
        );

        assert_eq!(first.relation_set_sha, swapped.relation_set_sha);
        assert_ne!(first.relation_set_sha, extra.relation_set_sha);
    }
}

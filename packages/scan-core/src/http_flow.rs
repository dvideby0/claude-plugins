//! Bounded HTTP route semantics for TypeScript/JavaScript.
//!
//! This is deliberately a framework adapter, not a universal control-flow
//! engine. It recognizes the daemon's explicit `path === "/..."` route
//! guards, then preserves the small amount of control structure required to
//! explain each route's response effects. Unsupported control constructs are
//! emitted as visible gaps instead of being guessed through.

use tree_sitter::Node;

const PRODUCER_ID: &str = "sdlc-http-route-adapter";
const PRODUCER_VERSION: &str = "2";
const MAX_ENTRIES_PER_FILE: usize = 128;
const MAX_GUARD_ALTERNATIVES: usize = 256;
const MAX_NODES_PER_ENTRY: usize = 256;
const MAX_EDGES_PER_ENTRY: usize = 512;

#[derive(Default)]
pub struct ExecutionEntry {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub method: String,
    pub route: String,
    pub path: String,
    pub symbol: String,
    pub start_line: u32,
    pub end_line: u32,
    pub producer_id: String,
    pub producer_version: String,
    pub producer_kind: String,
    pub certainty: String,
    pub nodes: Vec<ExecutionNode>,
    pub edges: Vec<ExecutionEdge>,
    pub diagnostics: Vec<String>,
}

pub struct ExecutionNode {
    pub id: String,
    pub ordinal: u32,
    pub kind: String,
    pub label: String,
    pub path: String,
    pub symbol: String,
    pub target_symbol: String,
    pub target_line: u32,
    pub target_column: u32,
    pub external: String,
    pub start_line: u32,
    pub end_line: u32,
    pub certainty: String,
    pub terminal: bool,
    pub detail: String,
}

pub struct ExecutionEdge {
    pub ordinal: u32,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub label: String,
    pub path: String,
    pub start_line: u32,
    pub certainty: String,
}

#[derive(Clone)]
struct Frontier {
    from: String,
    kind: String,
    label: String,
    line: u32,
}

struct CallObservation<'tree> {
    node: Node<'tree>,
    callee: String,
    target_symbol: String,
    target_line: u32,
    target_column: u32,
    awaited: bool,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct GuardAlternative {
    route: Option<String>,
    method: Option<String>,
}

struct GuardAnalysis {
    alternatives: Vec<GuardAlternative>,
    truncated: bool,
}

#[derive(Clone, Copy)]
struct SourceAnchor {
    start_line: u32,
    end_line: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AbruptKind {
    Return,
    Throw,
}

#[derive(Clone)]
struct DeferredAbrupt {
    frontier: Frontier,
    kind: AbruptKind,
    source: SourceAnchor,
    label: String,
    external: String,
}

enum AbruptFrame {
    Catch(Vec<Frontier>),
    Finally(Vec<DeferredAbrupt>),
}

struct Builder<'a> {
    entry: ExecutionEntry,
    bytes: &'a [u8],
    next_node: u32,
    next_edge: u32,
    bounded: bool,
    abrupt_frames: Vec<AbruptFrame>,
}

fn text<'a>(node: Node, bytes: &'a [u8]) -> &'a str {
    node.utf8_text(bytes).unwrap_or("")
}

fn compact(value: &str, limit: usize) -> String {
    let flattened = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= limit {
        flattened
    } else {
        flattened.chars().take(limit).collect::<String>() + "…"
    }
}

fn unquote(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() < 2 {
        return None;
    }
    let first = value.as_bytes()[0];
    let last = value.as_bytes()[value.len() - 1];
    if !matches!(first, b'\'' | b'"' | b'`') || first != last {
        return None;
    }
    Some(value[1..value.len() - 1].to_string())
}

fn equality_guard(node: Node, bytes: &[u8]) -> Option<GuardAlternative> {
    let left = node.child_by_field_name("left")?;
    let right = node.child_by_field_name("right")?;
    let operator = node
        .child_by_field_name("operator")
        .map(|operator| text(operator, bytes));
    if !matches!(operator, Some("===") | Some("==")) {
        return None;
    }
    for (name, value) in [(left, right), (right, left)] {
        let literal = unquote(text(value, bytes));
        match (text(name, bytes).trim(), literal) {
            ("path", Some(route)) => {
                return Some(GuardAlternative {
                    route: Some(route),
                    method: None,
                });
            }
            ("method", Some(method)) => {
                return Some(GuardAlternative {
                    route: None,
                    method: Some(method),
                });
            }
            _ => {}
        }
    }
    None
}

fn merge_guards(left: &GuardAlternative, right: &GuardAlternative) -> Option<GuardAlternative> {
    let route = match (&left.route, &right.route) {
        (Some(left), Some(right)) if left != right => return None,
        (Some(value), _) | (_, Some(value)) => Some(value.clone()),
        _ => None,
    };
    let method = match (&left.method, &right.method) {
        (Some(left), Some(right)) if !left.eq_ignore_ascii_case(right) => return None,
        (Some(value), _) | (_, Some(value)) => Some(value.clone()),
        _ => None,
    };
    Some(GuardAlternative { route, method })
}

fn guard_analysis(node: Node, bytes: &[u8]) -> GuardAnalysis {
    if node.kind() == "parenthesized_expression" {
        let mut cursor = node.walk();
        return node
            .named_children(&mut cursor)
            .next()
            .map(|child| guard_analysis(child, bytes))
            .unwrap_or_else(|| GuardAnalysis {
                alternatives: vec![GuardAlternative::default()],
                truncated: false,
            });
    }
    if node.kind() != "binary_expression" {
        // In particular, do not recurse through unary `!`: a positive-looking
        // comparison below it has the opposite route meaning.
        return GuardAnalysis {
            alternatives: vec![GuardAlternative::default()],
            truncated: false,
        };
    }
    if let Some(guard) = equality_guard(node, bytes) {
        return GuardAnalysis {
            alternatives: vec![guard],
            truncated: false,
        };
    }
    let Some(left) = node.child_by_field_name("left") else {
        return GuardAnalysis {
            alternatives: vec![GuardAlternative::default()],
            truncated: false,
        };
    };
    let Some(right) = node.child_by_field_name("right") else {
        return GuardAnalysis {
            alternatives: vec![GuardAlternative::default()],
            truncated: false,
        };
    };
    let operator = node
        .child_by_field_name("operator")
        .map(|operator| text(operator, bytes));
    if !matches!(operator, Some("&&") | Some("||")) {
        return GuardAnalysis {
            alternatives: vec![GuardAlternative::default()],
            truncated: false,
        };
    }
    let left = guard_analysis(left, bytes);
    let right = guard_analysis(right, bytes);
    let mut alternatives = Vec::new();
    let mut truncated = left.truncated || right.truncated;
    if operator == Some("||") {
        for guard in left.alternatives.into_iter().chain(right.alternatives) {
            if !alternatives.contains(&guard) {
                if alternatives.len() >= MAX_GUARD_ALTERNATIVES {
                    truncated = true;
                    break;
                }
                alternatives.push(guard);
            }
        }
    } else {
        'outer: for left in &left.alternatives {
            for right in &right.alternatives {
                if let Some(guard) = merge_guards(left, right) {
                    if alternatives.contains(&guard) {
                        continue;
                    }
                    if alternatives.len() >= MAX_GUARD_ALTERNATIVES {
                        truncated = true;
                        break 'outer;
                    }
                    alternatives.push(guard);
                }
            }
        }
    }
    GuardAnalysis {
        alternatives,
        truncated,
    }
}

fn enclosing_symbol(mut node: Node, bytes: &[u8]) -> String {
    while let Some(parent) = node.parent() {
        node = parent;
        if matches!(node.kind(), "function_declaration" | "method_definition") {
            if let Some(name) = node.child_by_field_name("name") {
                return text(name, bytes).to_string();
            }
        }
        if matches!(node.kind(), "arrow_function" | "function_expression") {
            let mut ancestor = node;
            for _ in 0..3 {
                let Some(parent) = ancestor.parent() else {
                    break;
                };
                ancestor = parent;
                if ancestor.kind() == "variable_declarator" {
                    if let Some(name) = ancestor.child_by_field_name("name") {
                        return text(name, bytes).to_string();
                    }
                }
            }
        }
    }
    String::new()
}

fn last_property(node: Node, bytes: &[u8]) -> String {
    if node.kind() == "identifier" {
        return text(node, bytes).to_string();
    }
    if let Some(property) = node.child_by_field_name("property") {
        return text(property, bytes).to_string();
    }
    text(node, bytes)
        .rsplit(['.', '?'])
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

fn target_node(node: Node) -> Node {
    node.child_by_field_name("property").unwrap_or(node)
}

fn collect_calls<'tree>(
    node: Node<'tree>,
    bytes: &[u8],
    awaited: bool,
    output: &mut Vec<CallObservation<'tree>>,
) {
    if matches!(
        node.kind(),
        "arrow_function" | "function_expression" | "function_declaration"
    ) {
        return;
    }
    if node.kind() == "await_expression" {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            collect_calls(child, bytes, true, output);
        }
        return;
    }
    if node.kind() == "call_expression" {
        if let Some(arguments) = node.child_by_field_name("arguments") {
            let mut cursor = arguments.walk();
            for child in arguments.named_children(&mut cursor) {
                // Argument expressions are evaluated before the outer call.
                // Only their own await expressions suspend independently.
                collect_calls(child, bytes, false, output);
            }
        }
        if let Some(function) = node.child_by_field_name("function") {
            let target = target_node(function);
            output.push(CallObservation {
                node,
                callee: compact(text(function, bytes), 120),
                target_symbol: last_property(function, bytes),
                target_line: target.start_position().row as u32 + 1,
                target_column: target.start_position().column as u32,
                awaited,
            });
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_calls(child, bytes, awaited, output);
    }
}

fn ignored_call(call: &CallObservation) -> bool {
    if call.awaited {
        return false;
    }
    if call.callee.contains('.') || call.callee.contains("?.") {
        return true;
    }
    matches!(
        call.target_symbol.as_str(),
        "String" | "Number" | "Boolean" | "Object" | "Array" | "Error" | "URL"
    )
}

fn argument(call: Node, index: usize) -> Option<Node> {
    let arguments = call.child_by_field_name("arguments")?;
    let mut cursor = arguments.walk();
    let selected = arguments.named_children(&mut cursor).nth(index);
    selected
}

fn terminal_effect(call: &CallObservation, bytes: &[u8]) -> Option<(String, String)> {
    if call.target_symbol == "sendJson" {
        let status = argument(call.node, 1)
            .map(|node| compact(text(node, bytes), 24))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        return Some((
            format!("Respond HTTP {status}"),
            format!("http:response:{status}"),
        ));
    }
    if call.target_symbol == "end" {
        let receiver = call
            .callee
            .rsplit_once('.')
            .map(|(base, _)| base)
            .unwrap_or("");
        if matches!(receiver, "res" | "response") {
            return Some((
                "Finish HTTP response".to_string(),
                "http:response".to_string(),
            ));
        }
    }
    if call.callee == "process.exit" {
        return Some(("Exit process".to_string(), "process:exit".to_string()));
    }
    None
}

impl Builder<'_> {
    fn add_diagnostic(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.entry.diagnostics.contains(&message) {
            self.entry.diagnostics.push(message);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_node(
        &mut self,
        source: Node,
        kind: &str,
        label: String,
        symbol: String,
        target_symbol: String,
        target_line: u32,
        target_column: u32,
        external: String,
        terminal: bool,
        detail: String,
    ) -> Option<String> {
        self.add_node_at(
            SourceAnchor {
                start_line: source.start_position().row as u32 + 1,
                end_line: source.end_position().row as u32 + 1,
            },
            kind,
            label,
            symbol,
            target_symbol,
            target_line,
            target_column,
            external,
            terminal,
            detail,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn add_node_at(
        &mut self,
        source: SourceAnchor,
        kind: &str,
        label: String,
        symbol: String,
        target_symbol: String,
        target_line: u32,
        target_column: u32,
        external: String,
        terminal: bool,
        detail: String,
    ) -> Option<String> {
        if self.entry.nodes.len() >= MAX_NODES_PER_ENTRY {
            if !self.bounded {
                self.bounded = true;
                self.add_diagnostic(format!(
                    "Route exceeded {MAX_NODES_PER_ENTRY} execution nodes; remaining control flow was not expanded."
                ));
            }
            return None;
        }
        let ordinal = self.next_node;
        self.next_node += 1;
        let id = format!("{}:node:{ordinal}", self.entry.id);
        self.entry.nodes.push(ExecutionNode {
            id: id.clone(),
            ordinal,
            kind: kind.to_string(),
            label,
            path: self.entry.path.clone(),
            symbol,
            target_symbol,
            target_line,
            target_column,
            external,
            start_line: source.start_line,
            end_line: source.end_line,
            certainty: "inferred".to_string(),
            terminal,
            detail,
        });
        Some(id)
    }

    fn abrupt_handler_index(&self, kind: AbruptKind) -> Option<usize> {
        match kind {
            AbruptKind::Return => self
                .abrupt_frames
                .iter()
                .rposition(|frame| matches!(frame, AbruptFrame::Finally(_))),
            AbruptKind::Throw => self.abrupt_frames.len().checked_sub(1),
        }
    }

    fn propagate_abrupt(&mut self, abrupt: DeferredAbrupt) {
        let Some(index) = self.abrupt_handler_index(abrupt.kind) else {
            let kind = match abrupt.kind {
                AbruptKind::Return => "return",
                AbruptKind::Throw => "throw",
            };
            let detail = match abrupt.kind {
                AbruptKind::Return => {
                    "The pending return completes after all enclosing finalizers."
                }
                AbruptKind::Throw => "The pending exception leaves the recognized route.",
            };
            let Some(id) = self.add_node_at(
                abrupt.source,
                kind,
                format!("Complete {}", abrupt.label),
                self.entry.symbol.clone(),
                String::new(),
                0,
                0,
                abrupt.external,
                true,
                detail.to_string(),
            ) else {
                return;
            };
            self.connect(&[abrupt.frontier], &id);
            return;
        };

        match &mut self.abrupt_frames[index] {
            AbruptFrame::Catch(frontiers) => frontiers.push(Frontier {
                from: abrupt.frontier.from,
                kind: "catch".to_string(),
                label: "explicit throw caught".to_string(),
                line: abrupt.frontier.line,
            }),
            AbruptFrame::Finally(abrupts) => abrupts.push(abrupt),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_abrupt(
        &mut self,
        source: Node,
        incoming: Vec<Frontier>,
        kind: AbruptKind,
        label: String,
        external: String,
        detail: String,
    ) {
        let handled = self.abrupt_handler_index(kind).is_some();
        let node_kind = match kind {
            AbruptKind::Return => "return",
            AbruptKind::Throw => "throw",
        };
        let Some(id) = self.add_node(
            source,
            node_kind,
            label.clone(),
            self.entry.symbol.clone(),
            String::new(),
            0,
            0,
            external.clone(),
            !handled,
            detail,
        ) else {
            return;
        };
        self.connect(&incoming, &id);
        if handled {
            self.propagate_abrupt(DeferredAbrupt {
                frontier: Frontier {
                    from: id,
                    kind: "next".to_string(),
                    label: String::new(),
                    line: source.start_position().row as u32 + 1,
                },
                kind,
                source: SourceAnchor {
                    start_line: source.start_position().row as u32 + 1,
                    end_line: source.end_position().row as u32 + 1,
                },
                label,
                external,
            });
        }
    }

    fn connect(&mut self, incoming: &[Frontier], target: &str) {
        for frontier in incoming {
            if self.entry.edges.len() >= MAX_EDGES_PER_ENTRY {
                if !self.bounded {
                    self.bounded = true;
                    self.add_diagnostic(format!(
                        "Route exceeded {MAX_EDGES_PER_ENTRY} execution edges; remaining control flow was not expanded."
                    ));
                }
                return;
            }
            let ordinal = self.next_edge;
            self.next_edge += 1;
            self.entry.edges.push(ExecutionEdge {
                ordinal,
                from: frontier.from.clone(),
                to: target.to_string(),
                kind: frontier.kind.clone(),
                label: frontier.label.clone(),
                path: self.entry.path.clone(),
                start_line: frontier.line,
                certainty: "inferred".to_string(),
            });
        }
    }

    fn next_frontier(&self, id: String, line: u32) -> Vec<Frontier> {
        vec![Frontier {
            from: id,
            kind: "next".to_string(),
            label: String::new(),
            line,
        }]
    }

    fn emit_gap(&mut self, node: Node, incoming: Vec<Frontier>, construct: &str) -> Vec<Frontier> {
        let label = format!("{construct} control flow is not expanded");
        let Some(id) = self.add_node(
            node,
            "gap",
            label.clone(),
            self.entry.symbol.clone(),
            String::new(),
            0,
            0,
            String::new(),
            false,
            "The HTTP adapter preserves this unsupported construct as an explicit uncertainty gap."
                .to_string(),
        ) else {
            return incoming;
        };
        self.connect(&incoming, &id);
        self.add_diagnostic(format!(
            "{}:{} contains {construct}; paths through it are incomplete.",
            self.entry.path,
            node.start_position().row + 1
        ));
        self.next_frontier(id, node.start_position().row as u32 + 1)
    }

    fn walk_block(&mut self, block: Node, mut incoming: Vec<Frontier>) -> Vec<Frontier> {
        let mut cursor = block.walk();
        for statement in block.named_children(&mut cursor) {
            if incoming.is_empty() || self.bounded {
                break;
            }
            incoming = self.walk_statement(statement, incoming);
        }
        incoming
    }

    fn walk_statement(&mut self, node: Node, incoming: Vec<Frontier>) -> Vec<Frontier> {
        if incoming.is_empty() || self.bounded {
            return incoming;
        }
        match node.kind() {
            "statement_block" | "else_clause" | "catch_clause" | "finally_clause" => {
                self.walk_block(node, incoming)
            }
            "if_statement" => self.walk_if(node, incoming),
            "try_statement" => self.walk_try(node, incoming),
            "switch_statement" => self.emit_gap(node, incoming, "switch"),
            "for_statement" | "for_in_statement" | "while_statement" | "do_statement" => {
                self.emit_gap(node, incoming, "loop")
            }
            "return_statement" => {
                let after_calls = self.walk_calls(node, incoming);
                if after_calls.is_empty() {
                    return after_calls;
                }
                let value = compact(text(node, self.bytes).trim_start_matches("return"), 100);
                let label = if value.is_empty() {
                    "Return".to_string()
                } else {
                    format!("Return {value}")
                };
                self.emit_abrupt(
                    node,
                    after_calls,
                    AbruptKind::Return,
                    label,
                    "return".to_string(),
                    "The handler exits without another recognized effect in this branch."
                        .to_string(),
                );
                Vec::new()
            }
            "throw_statement" => {
                self.emit_abrupt(
                    node,
                    incoming,
                    AbruptKind::Throw,
                    compact(text(node, self.bytes), 120),
                    "exception".to_string(),
                    "Exception leaves this route branch unless an enclosing handler catches it."
                        .to_string(),
                );
                Vec::new()
            }
            _ => self.walk_calls(node, incoming),
        }
    }

    fn walk_if(&mut self, node: Node, incoming: Vec<Frontier>) -> Vec<Frontier> {
        let Some(condition) = node.child_by_field_name("condition") else {
            return self.emit_gap(node, incoming, "condition");
        };
        let condition_label = compact(text(condition, self.bytes), 160);
        let Some(control) = self.add_node(
            condition,
            "branch",
            condition_label.clone(),
            self.entry.symbol.clone(),
            String::new(),
            0,
            0,
            String::new(),
            false,
            "Both syntactic outcomes are retained; runtime feasibility is not claimed.".to_string(),
        ) else {
            return incoming;
        };
        self.connect(&incoming, &control);

        let line = condition.start_position().row as u32 + 1;
        let consequence = node.child_by_field_name("consequence");
        let mut output = consequence
            .map(|consequence| {
                self.walk_statement(
                    consequence,
                    vec![Frontier {
                        from: control.clone(),
                        kind: "branch".to_string(),
                        label: format!("when {condition_label}"),
                        line,
                    }],
                )
            })
            .unwrap_or_default();

        if let Some(alternative) = node.child_by_field_name("alternative") {
            output.extend(self.walk_statement(
                alternative,
                vec![Frontier {
                    from: control,
                    kind: "branch".to_string(),
                    label: format!("otherwise ({condition_label})"),
                    line,
                }],
            ));
        } else {
            output.push(Frontier {
                from: control,
                kind: "branch".to_string(),
                label: format!("otherwise ({condition_label})"),
                line,
            });
        }
        output
    }

    fn walk_try(&mut self, node: Node, incoming: Vec<Frontier>) -> Vec<Frontier> {
        let finalizer = node.child_by_field_name("finalizer");
        if finalizer.is_some() {
            self.abrupt_frames.push(AbruptFrame::Finally(Vec::new()));
        }
        let handler = node.child_by_field_name("handler");
        let Some(control) = self.add_node(
            node,
            "branch",
            "Try block".to_string(),
            self.entry.symbol.clone(),
            String::new(),
            0,
            0,
            String::new(),
            false,
            "Normal and caught-exception outcomes are retained; the throwing operation is not guessed."
                .to_string(),
        ) else {
            if finalizer.is_some() {
                self.abrupt_frames.pop();
            }
            return incoming;
        };
        self.connect(&incoming, &control);
        let line = node.start_position().row as u32 + 1;
        if handler.is_some() {
            self.abrupt_frames.push(AbruptFrame::Catch(Vec::new()));
        }
        let mut output = node
            .child_by_field_name("body")
            .map(|body| {
                self.walk_statement(
                    body,
                    vec![Frontier {
                        from: control.clone(),
                        kind: "next".to_string(),
                        label: String::new(),
                        line,
                    }],
                )
            })
            .unwrap_or_default();
        if let Some(handler) = handler {
            let explicit_throws = match self.abrupt_frames.pop() {
                Some(AbruptFrame::Catch(frontiers)) => frontiers,
                _ => Vec::new(),
            };
            let catch_incoming = if explicit_throws.is_empty() {
                vec![Frontier {
                    from: control,
                    kind: "catch".to_string(),
                    label: "try block throws".to_string(),
                    line,
                }]
            } else {
                explicit_throws
            };
            output.extend(self.walk_statement(handler, catch_incoming));
        } else {
            self.emit_abrupt(
                node,
                vec![Frontier {
                    from: control,
                    kind: "throw".to_string(),
                    label: "try block throws".to_string(),
                    line,
                }],
                AbruptKind::Throw,
                "Unhandled exception".to_string(),
                "exception".to_string(),
                "No catch handler is present for this try block.".to_string(),
            );
        }
        if let Some(finalizer) = finalizer {
            let deferred = match self.abrupt_frames.pop() {
                Some(AbruptFrame::Finally(abrupts)) => abrupts,
                _ => Vec::new(),
            };
            output = self.walk_statement(finalizer, output);
            for abrupt in deferred {
                let resumed = self.walk_statement(finalizer, vec![abrupt.frontier.clone()]);
                for frontier in resumed {
                    self.propagate_abrupt(DeferredAbrupt {
                        frontier,
                        ..abrupt.clone()
                    });
                }
            }
        }
        output
    }

    fn walk_calls(&mut self, node: Node, mut incoming: Vec<Frontier>) -> Vec<Frontier> {
        let mut calls = Vec::new();
        collect_calls(node, self.bytes, false, &mut calls);
        for call in calls {
            if let Some((label, external)) = terminal_effect(&call, self.bytes) {
                let Some(id) = self.add_node(
                    call.node,
                    "terminal-effect",
                    label,
                    self.entry.symbol.clone(),
                    call.target_symbol,
                    call.target_line,
                    call.target_column,
                    external,
                    true,
                    "Recognized by the bounded HTTP response adapter.".to_string(),
                ) else {
                    return incoming;
                };
                self.connect(&incoming, &id);
                return Vec::new();
            }
            if ignored_call(&call) {
                continue;
            }

            let kind = if call.awaited { "await" } else { "call" };
            let label = if call.awaited {
                format!("Await {}", call.callee)
            } else {
                format!("Call {}", call.callee)
            };
            let Some(id) = self.add_node(
                call.node,
                kind,
                label,
                self.entry.symbol.clone(),
                call.target_symbol,
                call.target_line,
                call.target_column,
                String::new(),
                false,
                if call.awaited {
                    "Execution suspends until this operation settles; resume timing is not inferred."
                        .to_string()
                } else {
                    "Syntactic call observed inside the recognized route branch.".to_string()
                },
            ) else {
                return incoming;
            };
            self.connect(&incoming, &id);
            incoming = self.next_frontier(id, call.node.start_position().row as u32 + 1);
        }
        incoming
    }
}

fn build_entry(
    path: &str,
    node: Node,
    bytes: &[u8],
    route: String,
    method: String,
) -> ExecutionEntry {
    let line = node.start_position().row as u32 + 1;
    let column = node.start_position().column as u32;
    let symbol = enclosing_symbol(node, bytes);
    let method = if method.is_empty() {
        "ANY".to_string()
    } else {
        method.to_ascii_uppercase()
    };
    let label = format!("{method} {route}");
    let id = format!("{path}#http:{method}:{route}@{line}:{column}");
    let mut builder = Builder {
        entry: ExecutionEntry {
            id: id.clone(),
            kind: "http-route".to_string(),
            label: label.clone(),
            method,
            route,
            path: path.to_string(),
            symbol: symbol.clone(),
            start_line: line,
            end_line: node.end_position().row as u32 + 1,
            producer_id: PRODUCER_ID.to_string(),
            producer_version: PRODUCER_VERSION.to_string(),
            producer_kind: "framework".to_string(),
            certainty: "inferred".to_string(),
            nodes: Vec::new(),
            edges: Vec::new(),
            diagnostics: Vec::new(),
        },
        bytes,
        next_node: 0,
        next_edge: 0,
        bounded: false,
        abrupt_frames: Vec::new(),
    };

    let entry_node = builder
        .add_node(
            node,
            "entry",
            label,
            symbol,
            String::new(),
            0,
            0,
            String::new(),
            false,
            "HTTP route guard recognized from source syntax.".to_string(),
        )
        .expect("the first bounded route node always fits");
    if let Some(body) = node.child_by_field_name("consequence") {
        let remaining = builder.walk_statement(
            body,
            vec![Frontier {
                from: entry_node,
                kind: "next".to_string(),
                label: String::new(),
                line,
            }],
        );
        for frontier in remaining {
            if builder.bounded {
                break;
            }
            let Some(gap) = builder.add_node(
                node,
                "gap",
                "Route branch exits without a recognized terminal effect".to_string(),
                builder.entry.symbol.clone(),
                String::new(),
                0,
                0,
                String::new(),
                true,
                "The adapter reached the end of the guarded block without seeing a response, throw, or return."
                    .to_string(),
            ) else {
                break;
            };
            builder.connect(&[frontier], &gap);
        }
    }
    builder.entry
}

fn visit(
    path: &str,
    node: Node,
    bytes: &[u8],
    entries: &mut Vec<ExecutionEntry>,
    truncated: &mut bool,
) {
    if node.kind() == "if_statement" {
        if let Some(condition) = node.child_by_field_name("condition") {
            let analysis = guard_analysis(condition, bytes);
            let mut guards = analysis
                .alternatives
                .into_iter()
                .filter_map(|guard| {
                    let route = guard.route?;
                    route
                        .starts_with('/')
                        .then_some((route, guard.method.unwrap_or_default()))
                })
                .collect::<Vec<_>>();
            guards.sort();
            guards.dedup();
            if !guards.is_empty() {
                for (route, method) in guards {
                    if entries.len() >= MAX_ENTRIES_PER_FILE {
                        *truncated = true;
                        break;
                    }
                    let mut entry = build_entry(path, node, bytes, route, method);
                    if analysis.truncated {
                        entry.diagnostics.push(format!(
                            "{}:{} has more than {MAX_GUARD_ALTERNATIVES} boolean route alternatives; remaining alternatives were not indexed.",
                            path,
                            condition.start_position().row + 1
                        ));
                    }
                    entries.push(entry);
                }
                // Nested path guards are separate routes only when they are
                // not already owned by this recognized guarded block.
                return;
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        visit(path, child, bytes, entries, truncated);
        if *truncated {
            break;
        }
    }
}

pub fn extract(path: &str, root: Node, bytes: &[u8]) -> Vec<ExecutionEntry> {
    let mut entries = Vec::new();
    let mut truncated = false;
    visit(path, root, bytes, &mut entries, &mut truncated);
    if truncated {
        let diagnostic = format!(
            "{path} contains more than {MAX_ENTRIES_PER_FILE} recognized HTTP entries; the file-level route inventory was truncated."
        );
        for entry in &mut entries {
            if !entry.diagnostics.contains(&diagnostic) {
                entry.diagnostics.push(diagnostic.clone());
            }
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::{Language, Parser};

    fn extract_typescript(source: &str) -> Vec<ExecutionEntry> {
        let language: Language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into();
        let mut parser = Parser::new();
        parser.set_language(&language).expect("grammar loads");
        let tree = parser.parse(source, None).expect("source parses");
        extract("src/http.ts", tree.root_node(), source.as_bytes())
    }

    #[test]
    fn maps_guarded_http_branches_to_response_effects() {
        let source = r#"
async function handleApi(path: string, method: string, res: unknown) {
  if (path === "/api/search" && method === "GET") {
    let term: string;
    try {
      term = normalizeSearchQuery("input");
    } catch (error) {
      sendJson(res, 400, { error: String(error) });
      return true;
    }
    if (!valid(term)) {
      sendJson(res, 400, { error: "bad kind" });
      return true;
    }
    const workspaces = await registry.list();
    sendJson(res, 200, await crossQuery(workspaces, term));
    return true;
  }
}
"#;
        let entries = extract_typescript(source);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.label, "GET /api/search");
        assert_eq!(entry.symbol, "handleApi");
        assert!(entry.diagnostics.is_empty());

        let labels = entry
            .nodes
            .iter()
            .map(|node| node.label.as_str())
            .collect::<Vec<_>>();
        assert!(labels.contains(&"Call normalizeSearchQuery"));
        assert!(labels.contains(&"Await registry.list"));
        assert!(labels.contains(&"Await crossQuery"));
        assert_eq!(
            entry
                .nodes
                .iter()
                .filter(|node| node.kind == "terminal-effect")
                .count(),
            3
        );
        assert_eq!(
            entry
                .nodes
                .iter()
                .filter(|node| node.external == "http:response:400")
                .count(),
            2
        );
        assert!(entry.edges.iter().any(|edge| edge.kind == "catch"));
        assert!(entry.edges.iter().any(|edge| edge.kind == "branch"));
    }

    #[test]
    fn preserves_positive_boolean_route_alternatives_without_cross_pairing() {
        let entries = extract_typescript(
            r#"function route(path: string, method: string, res: unknown) {
              if (path === "/" || path === "/index.html") { res.end(); }
              if (!(path === "/excluded")) { sendJson(res, 201, {}); }
              if ((path === "/get" && method === "GET") ||
                  (path === "/post" && method === "POST")) { sendJson(res, 202, {}); }
            }"#,
        );
        let mut labels = entries
            .iter()
            .map(|entry| entry.label.as_str())
            .collect::<Vec<_>>();
        labels.sort();
        assert_eq!(
            labels,
            ["ANY /", "ANY /index.html", "GET /get", "POST /post"]
        );
        assert!(entries.iter().all(|entry| {
            entry
                .nodes
                .iter()
                .any(|node| node.kind == "terminal-effect")
        }));
    }

    #[test]
    fn keeps_same_line_duplicate_routes_collision_free() {
        let entries = extract_typescript(
            r#"function a(path: string, res: unknown) { if (path === "/x") { sendJson(res, 200, {}); } } function b(path: string, res: unknown) { if (path === "/x") { sendJson(res, 200, {}); } }"#,
        );
        assert_eq!(entries.len(), 2);
        assert_ne!(entries[0].id, entries[1].id);
    }

    #[test]
    fn distinguishes_nested_calls_from_the_awaited_outer_call() {
        let entries = extract_typescript(
            r#"async function route(path: string, res: unknown) {
              if (path === "/await") { await outer(inner()); sendJson(res, 200, {}); }
            }"#,
        );
        let operations = entries[0]
            .nodes
            .iter()
            .filter(|node| matches!(node.kind.as_str(), "call" | "await"))
            .map(|node| (node.kind.as_str(), node.label.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            operations,
            [("call", "Call inner"), ("await", "Await outer")]
        );
    }

    #[test]
    fn routes_explicit_throws_into_catches_and_runs_finally_before_return() {
        let entries = extract_typescript(
            r#"function route(path: string, res: unknown) {
              if (path === "/caught") {
                try { throw new Error("bad"); }
                catch (error) { sendJson(res, 400, { error }); }
              }
              if (path === "/finally") {
                try { return work(); }
                finally { sendJson(res, 200, {}); }
              }
            }"#,
        );
        let caught = entries
            .iter()
            .find(|entry| entry.route == "/caught")
            .expect("caught route");
        let throw = caught
            .nodes
            .iter()
            .find(|node| node.kind == "throw")
            .expect("explicit throw node");
        assert!(!throw.terminal);
        assert!(caught
            .edges
            .iter()
            .any(|edge| edge.from == throw.id && edge.kind == "catch"));
        assert!(!caught
            .nodes
            .iter()
            .any(|node| node.terminal && node.external == "exception"));

        let finally = entries
            .iter()
            .find(|entry| entry.route == "/finally")
            .expect("finally route");
        assert!(finally
            .nodes
            .iter()
            .any(|node| node.terminal && node.external == "http:response:200"));
        assert!(!finally
            .nodes
            .iter()
            .any(|node| node.terminal && node.external == "return"));
    }

    #[test]
    fn exposes_the_per_file_entry_cap_as_a_diagnostic() {
        let mut source = String::from("function route(path: string, res: unknown) {");
        for index in 0..=MAX_ENTRIES_PER_FILE {
            source.push_str(&format!(
                "if (path === '/route-{index}') {{ sendJson(res, 200, {{}}); }}"
            ));
        }
        source.push('}');
        let entries = extract_typescript(&source);
        assert_eq!(entries.len(), MAX_ENTRIES_PER_FILE);
        assert!(entries.iter().all(|entry| entry
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("inventory was truncated"))));
    }

    #[test]
    fn records_unsupported_loops_as_gaps() {
        let entries = extract_typescript(
            r#"function route(path: string, res: unknown) {
              if (path === "/loop") {
                while (ready()) { sendJson(res, 200, {}); }
              }
            }"#,
        );
        assert_eq!(entries.len(), 1);
        assert!(entries[0].nodes.iter().any(|node| node.kind == "gap"));
        assert!(entries[0]
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("incomplete")));
    }
}

# MCP tools

> [Reference](README.md) · [Documentation hub](../README.md)

Every tool the engine exposes over MCP, grouped by what it is for. Each row
quotes the tool's own registered description.

The tool set and each tool's one-line purpose are canonical in
`packages/engine/src/mcp/server.ts`; parameters are canonical in its schemas and
are not restated here. Why these capabilities exist, and what they cannot see,
is [`ENGINE_DESIGN.md`](../ENGINE_DESIGN.md).

## Context and retrieval

| Tool | For |
|---|---|
| `brief` | Build a task-first, byte-budgeted briefing from ranked lexical, graph, flow, finding, memory, test, and source evidence. Use before reading broadly |
| `context` | Everything known about a file or symbol before you change it: what it is, what depends on it, open findings, and what previous sessions recorded about it |
| `search_code` | Search by code shape rather than text: every empty catch block, every bare except, every throw |
| `cross_search` | Search every repository this engine indexes at once across paths, symbols, components, flows, findings, relations, and memories |
| `read_file` | Read a bounded, numbered slice of a text file inside the current workspace. Paths that escape through `..` or symlinks are rejected |

## Graph and navigation

| Tool | For |
|---|---|
| `references` | Every place a symbol is used, with file and line. Answers "who calls this function" — not just which files import its module |
| `trace` | Follow the call chain from a symbol — what it calls, transitively, or what calls it |
| `impact` | What would need re-checking if this file changed: which of its exports are actually used, by which files, and which tests already cover them |
| `flow` | Evidence-backed execution paths from recognized entries to terminal outcomes and effects |
| `resolve_types` | Upgrade references from import-resolved to type-resolved using the TypeScript checker. Prototype |

## Map authoring

| Tool | For |
|---|---|
| `map` | The system as someone would draw it: named components, the flows through them, and cross-cutting tags. The interpreted map, not the file graph |
| `map_drift` | Which parts of the drawn map the code has moved out from under, and nothing else |
| `describe_component` | Draw a box on the map: a named region of the codebase and what it is for. Components nest |
| `describe_flow` | Draw an arrow on the map: a named path through the system, in order, with a note on each step |
| `tag` | Label a file or symbol by its nature rather than its location: entrypoint, adapter, model-call, io, config |
| `gaps` | What the index cannot explain, ranked — the worklist for making the map real |
| `finalize_map` | Mark the initial authored map complete. Every unassigned file must either be mapped or explicitly excluded |

## Knowledge

| Tool | For |
|---|---|
| `remember` | Record something about this codebase that reading the code will not tell you: why a decision was made, a convention to follow, a trap to avoid |
| `recall` | Search what previous sessions recorded about this codebase. Use before re-deriving why something is the way it is |
| `forget` | Mark a memory superseded when it is no longer true. It stops surfacing but is kept for history |
| `relate` | Record an edge the parser could not derive — a framework registration, a route, an event handler. Requires the line of code that proves it |
| `relations` | Edges recorded by earlier reading, with the evidence for each. Ones whose source file has changed since are flagged |
| `explored` | Mark a file as examined, with how many relations came out of it. Stops the enrichment loop revisiting the same ground |

## Audit pipeline

| Tool | For |
|---|---|
| `audit_status` | Report what the audit store already knows: last run, indexed files, open findings, and the next step |
| `audit_scan` | Index the repository: walk files, extract symbols and imports with tree-sitter, resolve the dependency graph. Incremental |
| `audit_run_tools` | Run deterministic analysis: the project's own linters and type checkers, secret scanning, dependency advisories, and import-cycle detection |
| `audit_plan` | Rank files by risk (blast radius, churn, open findings, test coverage, size) and group them into review units for sub-agents |
| `audit_context` | Build the review prompt for one unit: rules, findings already known, graph neighbourhood, and source packed to budget |
| `audit_review` | Run the model review pass in the engine: review each planned unit with a headless coding CLI, then verify every proposed finding against the source before recording it |
| `audit_record_findings` | Record review findings. Deduplicated by fingerprint, suppressions applied. The only way agents write findings |
| `audit_query` | Query the audit store: review rules, symbol definitions, importers, imports, findings, hotspots, external packages, cycles |
| `audit_suppress` | Mark a finding accepted or a false positive, or silence a rule under a path. Suppressions persist across runs |
| `audit_report` | Return the audit report, repository map and task list from the store. Nothing is written to disk |

---

Tool names and parameters are defined in `packages/engine/src/mcp/server.ts`.
This page routes and explains; it does not restate a schema. Documentation
placement rules live in the [documentation hub](../README.md).

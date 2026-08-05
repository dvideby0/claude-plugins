# Current-state audit

Audit date: 2026-08-05. This describes the work-in-progress working tree, not just the last committed revision.

## Executive assessment

The repository already validates the most important architectural choice: a reusable local engine, a daemon-served interface, a desktop supervisor, and thin tool integrations can be packaged as one system. The project is beyond a throwaway proof of concept. It has a meaningful schema, native parsing, a working MCP surface, a useful initial UI, packaging automation, and a healthy TypeScript test suite.

The largest mismatch is terminology and depth around “flow.” The current deterministic model is primarily files, symbols, imports, and identifier references. Its flow and trace views traverse a call-like symbol graph; they do not yet model control-flow branches, conditions, exceptions, async transitions, data flow, framework dispatch, or terminal effects. The human map and memory layers are promising, but are mostly agent-authored and become stale at whole-file granularity.

The other structural risk is storage. The engine currently writes a `sql.js` database inside each repository and exports the whole database on flush. That is workable for a prototype but conflicts with the intended app-owned runtime and will become expensive as facts, source anchors, control-flow edges, search indexes, and derived knowledge grow.

## Maturity by capability

| Capability | Current maturity | Assessment |
| --- | --- | --- |
| App/engine/integration separation | Strong foundation | The package boundaries match the product direction. |
| File and symbol indexing | Functional prototype | Fast native TS/JS/Python extraction with a TypeScript fallback. |
| Precise references | Partial | TypeScript enrichment improves results; fallback has no reference extraction and language coverage is narrow. |
| Execution and data flow | Early | The current “flow” is a call graph with heuristic roots, not entry-to-effect program flow. |
| Human-readable system map | Promising | Components and ordered flows exist, but they are authored overlays rather than evidence-derived semantic objects. |
| Incremental recomputation | Basic | Content hashes avoid some database rewrites, but invalidation is file-level and native scans still revisit the repository. |
| Search and context retrieval | Early | Targeted briefs and cross-search exist; ranking is largely exact/keyword and has no retrieval evaluation. |
| Memories and notes | Basic | Anchored durable notes exist; search, evidence, validation, editing, and fine-grained staleness need work. |
| Desktop experience | Functional shell | Useful maps and operational views exist, but it is not yet a complete code-intelligence workspace. |
| Claude/Codex installation | Partial | MCP connection exists; complete plugin/skill lifecycle and supported Codex configuration are missing. |
| Packaging and CI | Promising | Desktop packaging, native build matrices, smoke scripts, and plugin validation are present. |
| Quality measurement | Mixed | Unit coverage is useful; Rust unit tests, golden analysis corpora, system benchmarks, and retrieval/product evals are absent. |

## What exists today

### Runtime shape

- [`packages/engine`](../packages/engine) contains the scanner, relational store, graph/query logic, MCP server, HTTP daemon, and browser UI.
- [`packages/scan-core`](../packages/scan-core) is a Rust/N-API Tree-sitter scanner for TypeScript, JavaScript, and Python.
- [`packages/mcp-bridge`](../packages/mcp-bridge) is the thin stdio-to-local-service bridge.
- [`packages/protocol`](../packages/protocol) defines discovery, paths, and shared types.
- [`apps/desktop`](../apps/desktop) is an Electron host that starts or adopts the daemon and displays its UI.
- [`plugins/sdlc`](../plugins/sdlc) is the current Claude companion plugin.

This is the right high-level boundary: one intelligence engine can serve the app and multiple agent clients.

### Deterministic facts and authored knowledge

The schema in [`packages/engine/src/db/schema.ts`](../packages/engine/src/db/schema.ts) already distinguishes several useful domains:

- files, symbols, imports, and references;
- audit runs, findings, suppressions, and tool executions;
- human-authored components and ordered flow steps;
- tags and asserted relations with confidence and evidence;
- exploration state;
- memories with file anchors and content hashes;
- review runs.

That is a good substrate for evolving toward base facts and derived overlays. The missing piece is an explicit, consistent provenance and dependency model across every fact type.

### Scanning and reference resolution

The scanner hashes files, extracts symbols/imports/references, and supports full and changed-file updates. Changing the extractor version forces a refresh. The Rust path is materially faster than the TypeScript path on the current repository.

Important limits:

- The TypeScript fallback deliberately produces no identifier references.
- Typed enrichment is TypeScript-specific.
- Stable symbol identity includes source position, so unrelated line movement can create avoidable churn.
- “Incremental” currently limits database replacement, but repository walking, hashing, and native parsing are not yet a fine-grained persistent incremental pipeline.
- Recursive filesystem watching has platform-dependent behavior and can silently fall back to no watcher.

### Graph, flow, and gap handling

[`packages/engine/src/graph/flow.ts`](../packages/engine/src/graph/flow.ts) constructs layers of callable symbols from reference edges. An entry point is inferred as a callable symbol that has callees and no incoming call. [`packages/engine/src/graph/trace.ts`](../packages/engine/src/graph/trace.ts) performs related transitive traversal.

This is useful call-graph navigation, but it should not be presented as deterministic execution flow yet. It lacks:

- basic blocks and branch conditions;
- call/return pairing and interprocedural context;
- exceptions, awaits, callbacks, and event dispatch;
- sources, values, reads/writes, and data dependencies;
- framework-specific registration and dispatch;
- recognized external or terminal effects;
- per-edge provenance and uncertainty in traversal.

The gap workflow in [`packages/engine/src/graph/gaps.ts`](../packages/engine/src/graph/gaps.ts) and asserted relations in [`packages/engine/src/graph/relations.ts`](../packages/engine/src/graph/relations.ts) are valuable escape hatches. However, asserted relations are not yet a first-class overlay in the main flow and trace queries, so teaching the system a missed relationship does not consistently improve its answers.

### Human map and memory

Components, memberships, flows, tags, and memories let agents preserve information that parsers cannot discover. Drift is detected by comparing stored file hashes with current hashes.

The current lifecycle is coarse:

- a comment edit can stale an entire anchored artifact;
- a symbol can move and lose identity despite retaining meaning;
- semantic objects do not declare dependencies on facts or other derived objects;
- memory recall uses keyword matching rather than full-text, graph, or hybrid ranking;
- provenance is mostly a source string rather than evidence records and authorship history;
- the desktop is better at viewing memories than creating, correcting, approving, or resolving them.

### MCP and context delivery

The MCP server in [`packages/engine/src/mcp/server.ts`](../packages/engine/src/mcp/server.ts) exposes a broad set of tools for auditing, context, reference lookup, tracing, maps, gaps, structural search, flow, impact, typed resolution, briefs, cross-search, memory, and review.

The breadth proves the engine has useful primitives. It also creates overlap and discovery cost for an agent. A smaller intent-oriented query surface could compose these primitives internally, return evidence and uncertainty consistently, and enforce an explicit context budget.

The `brief` implementation is a good beginning: it assembles nearby symbols, impact, tests, memories, findings, and recommended files. Relevance is still mostly based on explicit targets and keyword matches rather than evaluated lexical/graph/semantic ranking.

### Desktop application

The desktop app can supervise the daemon, add/index projects, inspect overview/map/flow/graph/findings/memory views, draw maps, and show integration status. This makes the architecture tangible.

Today it remains primarily an operational viewer. The next product step is a question-centered workspace with global search, source display, precise navigation, callers/callees, saved paths, synchronized code and graph views, change comparison, knowledge editing, and index-health explanations. The engine already has a cross-search endpoint that is not yet elevated into the main UI.

### Tool integration

The app detects Claude and Codex command-line tools and can connect their MCP configuration. The current workflow does not install and manage the full companion bundles:

- the Claude plugin is not installed or upgraded as part of the app workflow;
- there is no Codex plugin bundle in this repository;
- Codex configuration is edited directly rather than consistently using its supported CLI;
- desktop and CLI surfaces are not represented separately;
- there is no plan/apply/verify/repair/remove lifecycle with compatibility checks and user-visible diffs.

The official Claude and Codex plugin/marketplace interfaces make this achievable without placing product logic in the plugin itself.

### Storage and ownership

[`packages/protocol/src/paths.ts`](../packages/protocol/src/paths.ts) anticipates app-owned workspace stores under the user’s SDLC directory. [`packages/engine/src/db/db.ts`](../packages/engine/src/db/db.ts), however, currently writes `sdlc-audit/audit.db` inside the indexed repository, loads it through `sql.js`, and exports the database for persistence.

This discrepancy should be resolved before the data model expands. A bundled native SQLite owner behind the daemon is a simpler foundation for transactions, FTS5, concurrent readers, migrations, and incremental writes. Graph traversal can continue over indexed edge tables; a second graph database is not a prerequisite.

## Verification snapshot

The audit ran the following checks successfully against the working tree:

- `npm test`: 15 test files and 105 tests passed.
- `npm run typecheck`: engine, bridge, protocol, and desktop passed.
- `cargo test` in `packages/scan-core`: compiled and passed, but the crate currently contains zero Rust tests.
- `node scripts/bench.mjs .`: 127 files discovered, 84 parsed, 548 symbols and 342 imports, with no agreement differences reported. The native path completed in about 14 ms versus 158 ms for the TypeScript path, approximately 11.5× faster in this single local run.

These numbers are a useful health snapshot, not a durable benchmark. The benchmark needs fixed corpora, warm/cold separation, repeated samples, percentiles, correctness oracles, and memory/disk measurements before it can guide product claims.

## Highest-risk gaps

1. **The product promise outruns the flow model.** A call graph cannot yet support reliable entry-to-effect explanations.
2. **There is no canonical fact/provenance/invalidation contract.** Adding more analyzers now could create incompatible edge types and expensive rebuild behavior.
3. **The storage implementation will become a bottleneck.** Whole-database `sql.js` export and in-repository state are poor fits for the target scale and ownership boundary.
4. **Retrieval quality is unmeasured.** More tools and embeddings could add complexity without reducing file reads or improving task outcomes.
5. **The desktop has not yet found its signature human workflow.** Operational views demonstrate capability but do not yet compete with dedicated code-intelligence products.
6. **Integration lifecycle is incomplete.** MCP connectivity alone does not deliver the intended one-click Claude/Codex experience.
7. **Dynamic behavior needs an honesty model.** Framework dispatch and runtime behavior must be supported through labeled adapters, runtime observations, and assertions rather than implicit certainty.

## Overall conclusion

Keep the current application/engine/bridge split. Do not spend the next phase adding many more MCP tools or immediately introducing a graph database and embeddings. First establish the evidence model, evaluation corpus, app-owned storage, and one genuinely useful deterministic flow vertical slice. Those foundations make every later parser, UI view, semantic summary, memory, and agent integration more reliable.

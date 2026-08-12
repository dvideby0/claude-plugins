# Current-state audit

Audit date: 2026-08-05. This describes the work-in-progress working tree, not just the last committed revision.

Architecture correction, 2026-08-06: the existing TypeScript enrichment remains
a prototype, not a production semantic-indexing foundation. A bespoke expansion
of its project-resolution and freshness machinery was removed before commit.
Future precise references and deeper program analysis follow the
[provider-first strategy](PROVIDER_STRATEGY.md): import maintained SCIP,
compiler/language-server, or Code Property Graph outputs and concentrate SDLC
work on orchestration, evidence-backed fusion, retrieval, and product workflows.

Implementation update, 2026-08-10: the official SCIP TypeScript indexer is now
available through a bounded evaluation path. Its protobuf output is decoded and
hashed in Rust, its artifacts live in app-owned storage, and its capabilities
and comparison results appear in the desktop. It now runs against an app-owned
source snapshot that must match the deterministic index generation, records a
per-input manifest, verifies the input view after execution, and marks retained
output stale when the indexed source generation changes. Dependency and
out-of-tree compiler reads are not yet attested, so output remains partial and
unverified rather than exact. The output remains an evaluation and does not
replace current syntax/reference facts. Joern remains capability-detected and
unbundled. A digest-pinned, opt-in container spike now measures its CPG against
the LangGraph flow oracle; it is an evaluation path, not a production provider.

Implementation update, 2026-08-11: the weaker TypeScript repository walker and
WASM parser fallback were retired after the Rust core reached every supported
desktop target and produced better reference facts. Rust now owns the single
production source inventory, classification, hashing, and syntax boundary;
watch refreshes and deterministic content analyzers call its Rust-owned path
and inventory APIs. A
missing platform binary is reported as a broken installation rather than
silently changing fact coverage.

## Executive assessment

The repository already validates the most important architectural choice: a reusable local engine, a daemon-served interface, a desktop supervisor, and thin tool integrations can be packaged as one system. The project is beyond a throwaway proof of concept. It has a meaningful schema, native parsing, a working MCP surface, a useful initial UI, packaging automation, and a healthy TypeScript test suite.

The largest remaining mismatch is breadth around “flow.” The general-purpose
flow and trace views still traverse a call-like symbol graph. A first bounded
HTTP vertical slice now models guarded entries, branches, caught exceptions,
awaited calls, and response effects with evidence, but it is deliberately a
framework adapter rather than a universal control/data-flow engine. Most
languages, frameworks, dispatch styles, loops/switches, and data dependencies
remain outside that slice. The human map and memory layers are promising, but
are mostly agent-authored and become stale at whole-file granularity.

The native-storage foundation now writes each workspace's SQLite database under
the app-owned SDLC state directory and commits transactions directly through
the existing Rust module. Schema upgrades now have a Rust-owned compatibility
gate, integrity checks, transactional rollback, and validated recovery images.
The remaining storage risk is lifecycle correctness: path-derived identity does
not yet survive repository relocation, general corruption needs an explicit
restore workflow, and recovery remains user-directed. FTS5 is now wired into a
shared internal retrieval interface and incrementally maintained from the
authoritative relational rows.

## Maturity by capability

| Capability | Current maturity | Assessment |
| --- | --- | --- |
| App/engine/integration separation | Strong foundation | The package boundaries match the product direction. |
| File and symbol indexing | Functional prototype | Required Rust TS/JS/Python extraction with Rust-owned inventory and watcher policy. |
| Precise references | Partial | TypeScript enrichment improves results; official SCIP output can now be evaluated but is not yet imported from an immutable snapshot. |
| Execution and data flow | Early vertical slice | One measured HTTP adapter produces real entry-to-response paths; the general view remains a heuristic call graph and data flow is not modeled. |
| Human-readable system map | Promising | Components and ordered flows exist, but they are authored overlays rather than evidence-derived semantic objects. |
| Incremental recomputation | Explainable, not yet incremental | Syntax and interface signatures separate a change in meaning from a change in bytes, so a comment no longer drifts a map; one Rust policy decides and explains the input boundary. Repository walking still re-reads every file on every scan. |
| Search and context retrieval | Measured experimental vertical slice | The primary brief has Rust-owned lexical/graph/change ranking, bounded source evidence, exact response budgets, and a pinned Aider comparison; broader coverage and task outcomes keep it experimental. |
| Memories and notes | Basic | Anchored durable notes exist; search, evidence, validation, editing, and fine-grained staleness need work. |
| Desktop experience | Functional shell | Useful maps and operational views exist, but it is not yet a complete code-intelligence workspace. |
| Claude/Codex installation | Partial | MCP connection exists; complete plugin/skill lifecycle and supported Codex configuration are missing. |
| Packaging and CI | Promising | Desktop packaging, native build matrices, smoke scripts, and plugin validation are present. |
| Quality measurement | Emerging | One command now scores narrow provider and retrieval fixtures with official SCIP golden assertions, a real pinned Aider map, and one deterministic working-tree-change scenario; broader corpora, task outcomes, and provider-child resource measurement remain absent. |

## What exists today

### Runtime shape

- [`packages/engine`](../packages/engine) contains the scanner, relational store, graph/query logic, MCP server, HTTP daemon, and browser UI.
- [`packages/scan-core`](../packages/scan-core) owns the Rust/N-API Tree-sitter scanner and native SQLite lifecycle.
- [`packages/mcp-bridge`](../packages/mcp-bridge) is the thin stdio-to-local-service bridge.
- [`packages/protocol`](../packages/protocol) defines discovery, paths, and shared types.
- [`apps/desktop`](../apps/desktop) is an Electron host that starts or adopts the daemon and displays its UI.
- [`plugins/sdlc`](../plugins/sdlc) is the current Claude companion plugin.

This is the right high-level boundary: one intelligence engine can serve the app and multiple agent clients.

### Deterministic facts and authored knowledge

The frozen Rust-owned [schema v17](../packages/scan-core/src/database_schema_v17.sql)
already distinguishes several useful domains:

- files, symbols, imports, and references;
- audit runs, findings, suppressions, and tool executions;
- human-authored components and ordered flow steps;
- tags and asserted relations with confidence and evidence;
- exploration state;
- memories with file anchors and content hashes;
- review runs.

That is a good substrate for evolving toward base facts and derived overlays. The missing piece is an explicit, consistent provenance and dependency model across every fact type.

[Schema v18](../packages/scan-core/src/database_schema_v18.sql) adds an
external-content FTS5 index over those facts and authored overlays. The
relational rows remain authoritative; transactional triggers maintain the
derived search documents and their lifecycle state.

[Schema v19](../packages/scan-core/src/database_schema_v19.sql) keeps
deterministic framework-adapter execution graphs separate from agent-authored
flows. Entries, nodes, control edges, diagnostics, producer/certainty metadata,
evidence anchors, and per-file input hashes are replaced transactionally with
their owning source file.

[Schema v20](../packages/scan-core/src/database_schema_v20.sql) adds the exact
source occurrence and local spelling for execution-call targets. Syntax and
compiler reference passes can therefore refresh destination identity without
guessing through import aliases or default-import names.

The first versioned provider-neutral envelope is now documented in
[`FACT_MODEL.md`](FACT_MODEL.md), and the legacy deterministic/asserted tables
can be projected into it without changing their authority. SCIP facts are not
persisted through that contract, and dependency ownership is still incomplete.
Official SCIP occurrences and relationships can now be projected in memory
with workspace-bound provider-run ownership, artifact and input-manifest
verification, exact staged-root/path confinement, bounded collection,
conflict-safe document-local symbols, and explicit ambiguity.

### Scanning and reference resolution

The Rust scanner hashes files, extracts symbols/imports/references, and supports
full and changed-file updates. Changing the extractor version forces a refresh.
Its prebuilt module is required on every supported application target.

Important limits:

- Typed enrichment is TypeScript-specific.
- The stored symbol id still includes source position, so unrelated line movement changes it. Cross-scan comparison now uses `symbol_key`, which does not.
- “Incremental” currently limits database replacement, but repository walking, hashing, and native parsing are not yet a fine-grained persistent incremental pipeline.
- Recursive filesystem watching has platform-dependent behavior and can silently fall back to no watcher.

The provider evaluation layer now packages `@sourcegraph/scip-typescript`,
runs it with time/output bounds, retains five app-owned runs, and uses the
official Rust SCIP types to summarize definitions, references, relationships,
artifact provenance, and provider-neutral facts. It is a measurement path rather than a production fact
source: repository inputs are copied and attested in Rust before the provider
runs, but the unmanifested dependency/read closure keeps results unverified;
provider failure leaves the Tree-sitter index available. It discovers both `tsconfig.json` and
`jsconfig.json`, reports invalid or skipped projects and oversized-source skips
as partial output, and passes project paths through a hardened argument boundary
so legal flag-like directory names cannot become provider options. Provider
preflight validates bounded config text without expanding project globs on the
daemon thread; solution-style roots are passed through so SCIP can follow their
custom-named project references under its own process bounds.

The measurement harness also pins `@sourcegraph/scip-python` 0.6.6 as a
development-only comparator for a small LangGraph fixture. It runs with bounded
output and a deterministic empty package-environment description, preventing
its package-discovery phase from enumerating installed packages without
claiming filesystem sandboxing. It then reuses the same Rust SCIP
inspection/projection boundary. It improves the selected reference result from
the native scanner's 8/9 to 9/9, but contributes no framework or entry-to-effect
relations and is not exposed as a production app provider. Oracle schema version
2 now scopes providers per fixture and records reviewed flow truth while
the normal corpus still reports path quality as explicitly unmeasured. The
opt-in Joern spike recovers 12/13 reviewed relations and 3/4 exact
relation-sequence paths with no false positives after adding a narrow LangGraph
adapter. Its 2.17 GB extracted AMD64-only slim image and bounded full-GraphSON
translation fail desktop packaging criteria, so it remains evaluation-only.

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

The first exception is the bounded Rust-owned HTTP adapter in
[`packages/scan-core/src/http_flow.rs`](../packages/scan-core/src/http_flow.rs).
For explicit `path === "/..."` guards it constructs a small operation/control
graph, preserves bounded positive boolean route alternatives without inventing
facts from negation, retains both `if` outcomes and caught exceptions, runs
`finally` blocks before deferred returns or throws, labels the actually awaited
call (including calls evaluated by a nested condition), skips deferred callback
bodies, and recognizes concrete HTTP response effects only through the bounded
response-helper contract. Native SQLite enumerates paths with node/path limits
and cycle detection. Unsupported loop/switch control and bounded-input
truncation are preserved as visible diagnostics and keep affected paths
incomplete. Call and await nodes now expose whether their target actually
resolved; unresolved dispatch is counted and source-anchored as a gap, and any
path through it stays incomplete even when a later HTTP response is recognized.
A query-level regression covers explicit returns, uncaught throws, loops, and
switches end to end. Every enumerated path now reports a typed terminal outcome,
so clients can distinguish a response effect, return, exception, and gap without
inferring semantics from a null effect field. Loop iterations and switch cases
are still not expanded; their outcome remains explicitly incomplete.
A checked-in dogfood regression scans this repository itself and locks the
branches, response effects, evidence, provenance, and resolution limits for
`GET /api/search`, `ANY /api/watch`, and `POST /api/workspaces`. The adapter
still has provider-neutral precision/recall scoring for only one HTTP fixture
and does not fill the general gaps listed above.

The gap workflow in [`packages/engine/src/graph/gaps.ts`](../packages/engine/src/graph/gaps.ts) and asserted relations in [`packages/engine/src/graph/relations.ts`](../packages/engine/src/graph/relations.ts) are valuable escape hatches. Current, evidence-backed assertions can now be enabled as a separately labeled overlay in deterministic execution-flow queries without changing path facts. The older call-graph and trace queries do not yet expose the same overlay, so teaching the system a missed relationship still does not improve every answer consistently.

### Human map and memory

Components, memberships, flows, tags, and memories let agents preserve information that parsers cannot discover. Drift is detected by comparing stored file hashes with current hashes.

Schema v24 fixes the coarsest parts of that lifecycle. A comment-only edit no
longer stales an anchored artifact: components, flow steps, relations, memory
anchors, explorations and execution entries compare a comment-invariant syntax
signature, while findings and source slices keep comparing content because a
comment genuinely moves a line range. A symbol keeps a `symbol_key` that
survives cosmetic edits, and `artifact_dependencies` lets a component declare
the outside contracts it was drawn against, so a changed interface drifts the
summary without any file inside the box changing. Every verdict now carries a
sentence rather than a bare boolean.

What remains coarse:

- memory recall uses keyword matching rather than full-text, graph, or hybrid ranking;
- provenance is mostly a source string rather than evidence records and authorship history;
- prompt, model and semantic-result signatures have storage but no producer;
- the desktop is better at viewing memories than creating, correcting, approving, or resolving them.

### MCP and context delivery

The MCP server in [`packages/engine/src/mcp/server.ts`](../packages/engine/src/mcp/server.ts) exposes a broad set of tools for auditing, context, reference lookup, tracing, maps, gaps, structural search, flow, impact, typed resolution, briefs, cross-search, memory, and review.

The breadth proves the engine has useful primitives. It also creates overlap and discovery cost for an agent. A smaller intent-oriented query surface could compose these primitives internally, return evidence and uncertainty consistently, and enforce an explicit context budget.

The existing `brief` operation is now the experimental primary task-context
query rather than a single-target TypeScript composer. Its Rust planner combines
FTS5 with bounded one-hop graph, execution/authored flow, test, finding, memory,
relation, and exported-symbol evidence; the Node boundary reads only selected
contained source ranges and enforces an exact byte ceiling on the complete MCP
response. It exposes ranking reasons, provenance, freshness, omissions,
uncertainty, and recommended reads without adding another tool to the 33-tool
catalog. The path is not yet proven. A checked-in corpus now compares it with
actual digest-pinned Aider 0.86.2 output. The review task retrieves its checkout,
inventory, and covering-test evidence at 0.5 recall@5; the authored-memory debug
task retrieves its constraint and ledger declaration at 0.75 recall@4. Both
return zero irrelevant paths, cover all reviewed evidence, stay below 1,500
tokens, and use less than 1.5 times the map's actual tokens. Change relevance
and broader corpora remain open, so the response labels itself experimental
and no redundant public tools have been retired.

### Desktop application

The desktop app can supervise the daemon, add/index projects, inspect overview/map/flow/graph/findings/memory views, draw maps, and show integration status. This makes the architecture tangible.

Today it remains primarily an operational viewer. A first global search
workspace now queries paths, symbols, components, flows, findings, relations,
and memories across all indexed repositories and opens file-backed results in
the indexed file drawer. Flow now defaults to a question-centered
entry-to-effect path workspace when deterministic entries exist, with branches,
typed terminal outcomes and effects, evidence, provenance, freshness,
uncertainty, and the older call graph as a secondary mode. Returns and uncaught
throws no longer appear as generic handler exits. Selecting deterministic flow
steps or call-graph nodes now shows a bounded, range-highlighted source preview;
entries, resolved call targets, symbols, findings, and search results open the
same source surface at their indexed range. Current source is signature-checked
against the selected evidence generation, including historical findings and
authored flow assertions, and stale evidence is labeled instead of silently
highlighted as exact. Legacy evidence and live external-tool output without an
attested source snapshot are labeled unverified. Graph-canvas selection
synchronization, saved paths, richer
callers/callees and reference navigation, change comparison, knowledge editing,
and index-health explanations remain open.

A live desktop walkthrough on 2026-08-06 confirmed that repository validation,
deterministic rescanning, findings drill-down, stale-memory display, Claude and
Codex MCP connection, SCIP evaluation, cross-window provider refresh, and
component/file drill-down all work. Agent-authored map generation completed for
this repository and produced useful components and operational narratives. The
same workflow initially exited before finalization on a larger Python
repository because Claude deferred the app's MCP tools while the unattended
runner intentionally disabled built-in tools. The app now eagerly loads its
small allowlisted MCP surface. A resumed run completed with 12 named components,
five operational flows, and 98% coverage; a subsequent maintenance run refreshed
six drifted components and left every component and flow clean. Finalization now
rejects retained stale evidence, and maintenance completion no longer requires a
new-map marker. Interrupted work is therefore preserved and resumable, though
the product still needs cancellation UX, richer progress, and broader stress
coverage. The whole-repository graph became an unreadable dense cluster, while
the Flow view remained the bounded call-graph prototype described above.

The walkthrough also exposed an input-boundary defect: packaging output under
`release/` entered the source inventory and appeared as an unexplained file in
the newly drawn map. That is now closed. A single Rust `input_policy` decision
answers both the scan walk and the watcher and returns a typed reason for every
path; generated output is decided by the repository's own committed
`.gitignore`, with packaged-bundle and app-owned-storage rules that hold where
none exists. Schema v23 records those decisions — a pruned directory once
rather than its whole interior — and the Overview pane shows what was left out
and which rule left it out, so map coverage now has an explainable denominator.
Measured here, 218 walked files become 215 and the delta is exactly the four
leaked paths.

### Tool integration

The app detects Claude and Codex command-line tools and can connect their MCP configuration. The current workflow does not install and manage the full companion bundles:

- the Claude plugin is not installed or upgraded as part of the app workflow;
- there is no Codex plugin bundle in this repository;
- Codex configuration is edited directly rather than consistently using its supported CLI;
- desktop and CLI surfaces are not represented separately;
- there is no plan/apply/verify/repair/remove lifecycle with compatibility checks and user-visible diffs.

The official Claude and Codex plugin/marketplace interfaces make this achievable without placing product logic in the plugin itself.

### Storage and ownership

[`packages/protocol/src/paths.ts`](../packages/protocol/src/paths.ts) and
[`packages/engine/src/db/db.ts`](../packages/engine/src/db/db.ts) now agree on
app-owned workspace stores under the user's SDLC directory. The connection is
owned by the existing Rust N-API binary through bundled `rusqlite`; the
TypeScript `Db` class is a compatibility adapter, and `flush()` is a temporary
no-op while callers are migrated away from the former whole-export lifecycle.
An existing repository-local prototype database is copied once and retained as
a backup.

This provides the transaction and FTS5 retrieval foundation without adding a
second graph or vector database. Schema v17 moves compatibility checks, ordered
migration, its frozen schema declaration, `quick_check`, atomic online backups, and
rollback into the Rust SQLite owner; the TypeScript layer supplies only the
workspace path and existing cache adapter. Schema v18 uses SQLite's maintained
external-content index, tokenizer, prefix lookup, snippets, and BM25 through a
bounded Rust query interface; memory recall, cross-search, HTTP, and the desktop
share it. STORE-001 is not complete: stable identity across moves and an
explicit user-visible restore workflow for a generally corrupted store remain.

## Verification snapshot

The audit ran the following checks successfully against the working tree:

- `npm test`: 37 engine test files and 313 tests passed.
- `npm run build`: native core, engine, bridge, protocol, and desktop passed.
- `cargo test` in `packages/scan-core`: 50 Rust tests passed.
- The retired migration benchmark found 127 files, parsed 84, and reported 548
  symbols and 342 imports with no agreement differences. The Rust path took
  about 14 ms versus 158 ms for the former TypeScript path in that single run.

These numbers are a useful health snapshot, not a durable benchmark. The benchmark needs fixed corpora, warm/cold separation, repeated samples, percentiles, correctness oracles, and memory/disk measurements before it can guide product claims.

## Highest-risk gaps

1. **The product promise still outruns flow coverage.** One measured HTTP slice now supports reliable entry-to-response explanations, but it cannot be generalized to unadapted frameworks or data flow.
2. **There is no canonical fact/provenance/invalidation contract.** Adding more analyzers now could create incompatible edge types and expensive rebuild behavior.
3. **Storage identity and general corruption recovery are incomplete.** Direct native persistence, rollback-safe migrations, and internal FTS retrieval remove the whole-export, schema-upgrade, and SQL-scan risks, but path-derived workspace ids and an explicit restore workflow still need product behavior and tests.
4. **Retrieval quality is only narrowly measured.** The first two fixed tasks and one deterministic working-tree-change task beat their checked-in map baseline, but broader corpora and task outcomes remain unknown; more tools or embeddings would still be premature.
5. **The desktop has not yet found its signature human workflow.** Operational views demonstrate capability but do not yet compete with dedicated code-intelligence products.
6. **Integration lifecycle is incomplete.** MCP connectivity alone does not deliver the intended one-click Claude/Codex experience.
7. **Dynamic behavior needs an honesty model.** Framework dispatch and runtime behavior must be supported through labeled adapters, runtime observations, and assertions rather than implicit certainty.

## Overall conclusion

Keep the current application/engine/bridge split. Do not spend the next phase adding many more MCP tools or immediately introducing a graph database and embeddings. First establish the evidence model, evaluation corpus, app-owned storage, and one genuinely useful deterministic flow vertical slice. Those foundations make every later parser, UI view, semantic summary, memory, and agent integration more reliable.

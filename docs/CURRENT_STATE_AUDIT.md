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

## Executive assessment

The repository already validates the most important architectural choice: a reusable local engine, a daemon-served interface, a desktop supervisor, and thin tool integrations can be packaged as one system. The project is beyond a throwaway proof of concept. It has a meaningful schema, native parsing, a working MCP surface, a useful initial UI, packaging automation, and a healthy TypeScript test suite.

The largest mismatch is terminology and depth around “flow.” The current deterministic model is primarily files, symbols, imports, and identifier references. Its flow and trace views traverse a call-like symbol graph; they do not yet model control-flow branches, conditions, exceptions, async transitions, data flow, framework dispatch, or terminal effects. The human map and memory layers are promising, but are mostly agent-authored and become stale at whole-file granularity.

The other structural risk is storage. The engine currently writes a `sql.js` database inside each repository and exports the whole database on flush. That is workable for a prototype but conflicts with the intended app-owned runtime and will become expensive as facts, source anchors, control-flow edges, search indexes, and derived knowledge grow.

## Maturity by capability

| Capability | Current maturity | Assessment |
| --- | --- | --- |
| App/engine/integration separation | Strong foundation | The package boundaries match the product direction. |
| File and symbol indexing | Functional prototype | Fast native TS/JS/Python extraction with a TypeScript fallback. |
| Precise references | Partial | TypeScript enrichment improves results; official SCIP output can now be evaluated but is not yet imported from an immutable snapshot. |
| Execution and data flow | Early | The current “flow” is a call graph with heuristic roots, not entry-to-effect program flow. |
| Human-readable system map | Promising | Components and ordered flows exist, but they are authored overlays rather than evidence-derived semantic objects. |
| Incremental recomputation | Basic | Content hashes avoid some database rewrites, but invalidation is file-level and native scans still revisit the repository. |
| Search and context retrieval | Early | Targeted briefs and cross-search exist; ranking is largely exact/keyword and has no retrieval evaluation. |
| Memories and notes | Basic | Anchored durable notes exist; search, evidence, validation, editing, and fine-grained staleness need work. |
| Desktop experience | Functional shell | Useful maps and operational views exist, but it is not yet a complete code-intelligence workspace. |
| Claude/Codex installation | Partial | MCP connection exists; complete plugin/skill lifecycle and supported Codex configuration are missing. |
| Packaging and CI | Promising | Desktop packaging, native build matrices, smoke scripts, and plugin validation are present. |
| Quality measurement | Emerging | One command now scores a narrow fixture across fallback, native, compiler-prototype, and SCIP facts with official SCIP golden assertions; broader path/retrieval corpora and provider-child resource measurement remain absent. |

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

The first versioned provider-neutral envelope is now documented in
[`FACT_MODEL.md`](FACT_MODEL.md), and the legacy deterministic/asserted tables
can be projected into it without changing their authority. SCIP facts are not
persisted through that contract, and dependency ownership is still incomplete.
Official SCIP occurrences and relationships can now be projected in memory
with workspace-bound provider-run ownership, artifact and input-manifest
verification, exact staged-root/path confinement, bounded collection,
conflict-safe document-local symbols, and explicit ambiguity.

### Scanning and reference resolution

The scanner hashes files, extracts symbols/imports/references, and supports full and changed-file updates. Changing the extractor version forces a refresh. The Rust path is materially faster than the TypeScript path on the current repository.

Important limits:

- The TypeScript fallback deliberately produces no identifier references.
- Typed enrichment is TypeScript-specific.
- Stable symbol identity includes source position, so unrelated line movement can create avoidable churn.
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

The `brief` implementation is a good beginning: it assembles nearby symbols, impact, tests, memories, findings, and recommended files. Relevance is still mostly based on explicit targets and keyword matches rather than evaluated lexical/graph/semantic ranking. The first EVAL-001 command deliberately reports retrieval and entry-to-effect path quality as unmeasured rather than treating the new symbol/reference fixture as evidence for either claim.

### Desktop application

The desktop app can supervise the daemon, add/index projects, inspect overview/map/flow/graph/findings/memory views, draw maps, and show integration status. This makes the architecture tangible.

Today it remains primarily an operational viewer. The next product step is a question-centered workspace with global search, source display, precise navigation, callers/callees, saved paths, synchronized code and graph views, change comparison, knowledge editing, and index-health explanations. The engine already has a cross-search endpoint that is not yet elevated into the main UI.

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
the newly drawn map. Native and fallback scanners intentionally share the same
hard-coded exclusions, but neither currently applies the repository's ignored
generated-file policy. Source inclusion/exclusion must become deterministic,
explainable, and identical across full scans and watch refreshes before map
coverage is a trustworthy product metric.

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

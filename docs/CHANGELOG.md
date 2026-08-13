# Changelog

> [Documentation hub](README.md) · [SDLC](../README.md)

What shipped, dated. Looking for something else?

- What the implementation does today, and how mature it is → [current-state audit](CURRENT_STATE_AUDIT.md)
- Why an approach was chosen → [decisions](DECISIONS.md)
- What is still unfinished → [backlog](BACKLOG.md)
- How a surface behaves → [reference](reference/README.md)
- Measured provider and retrieval results → [evaluation](EVALUATION.md)

Entries are grouped by date, newest first, and tagged with the backlog item
they advanced. An item leaves the backlog only when all of its acceptance
criteria are met; these are the criteria that were.

An entry here means a criterion was met, **not** that the capability is proven.
Where the work reported itself as experimental or measured under a narrow
oracle, the entry says so — read those qualifiers as part of the outcome.

## 2026-08-13

**Incremental walking** (INCR-001). The walk takes a baseline and skips the read
for any file whose recorded filesystem identity still matches. The key is a
digest of device, inode, size, modification and change times compared for
equality only — not size and mtime, because `cp -p`, `rsync -a`, `tar -xm` and
restoring from backup all preserve those while replacing contents. A file whose
mtime is not strictly earlier than the walk that saw it records no key, which is
Git's index racy-clean rule moved to write time. Schema v25 stores the key beside
how each file's facts were established — read, verified, or sampled — so a file
nobody read stays distinguishable from one confirmed unchanged. A bounded
rotating sample of skipped files is read anyway and compared; a single
disagreement redoes the run reading everything and permanently drops that
workspace to the slow path. Measured here: a warm rescan reads none of 219 files
in 162 ms against 638 ms cold, with identical symbol, reference and edge counts.
Every path is still visited and stat'ed, which is how a deletion is noticed.

## 2026-08-12

**Native SQLite storage** (STORE-001). The engine owns a bundled `rusqlite`
connection inside the existing Rust N-API module. Stores are written under
`~/.sdlc/stores/<workspace-id>/audit.db`, use WAL transactions, and no longer
export an in-memory `sql.js` image. Opening a repository with a prototype
`sdlc-audit/audit.db` copies it into app-owned storage and retains the original
as a recoverable backup. → [decision](DECISIONS.md#native-sqlite-through-rusqlite-inside-the-existing-rust-module)

**Migration recovery** (STORE-001). Schema v17 establishes SQLite `user_version`
as the compatibility gate and records an ordered `schema_migrations` ledger. The
Rust storage owner runs `quick_check` before and after migration, rejects newer
or conflicting versions before enabling WAL, creates an atomic online backup
including committed WAL pages, normalizes it into one standalone database, and
applies every step in one immediate transaction. A tested failure rolls back both
DDL and version metadata while retaining the validated pre-migration image;
retries keep only the newest image for that target version.

**FTS5 retrieval** (STORE-001, SEARCH-001). Schema v18 uses external-content FTS5
tables, Unicode tokenizer, prefix indexes, BM25 ranking and snippets as a derived
access path over relational facts and authored knowledge. Triggers maintain
searchable files, symbols, memories, findings, components, flows and asserted
relations in the same transaction as their authoritative rows. One bounded Rust
query parser prevents callers injecting raw FTS syntax. Memory recall,
cross-repository search, the HTTP search endpoint and a new desktop global-search
workspace share that interface; no new MCP tool was added.

**Input boundary and signature hierarchy** (INCR-001). One Rust `input_policy`
module owns a single inclusion decision returning a typed reason, and both the
scan walk and the watcher ask it, so the two cannot drift. An explicit
`EntryKind` settles the hidden-segment rule the previous pair of functions
disagreed on. The generated-output rule consults the repository's own committed
`.gitignore` and only that — determinism across clones is what the earlier rule
was protecting. Schema v23 records the decisions the walk actually made, with
true per-reason totals beside a bounded sample. Measured here: of the files that
survived the previous policy, `git check-ignore` returns exactly four.

**HTTP vertical flow slice** (FLOW-001). A bounded Rust Tree-sitter framework
adapter recognizes explicit TypeScript/JavaScript HTTP route guards and persists
file-owned execution entries, operations, control edges, diagnostics, producer
identity, certainty, source evidence and input hashes in schema v19, with exact
call-target occurrences in v20. Schema v21 anchors finding ranges to the source
revision that produced them. The MCP `flow` operation prefers this model when
available while preserving the older call graph as `mode: calls`. A checked-in
HTTP fixture measures one entry, eight unique semantic relations, nine distinct
evidence occurrences and three paths at 1.0 precision/recall. A dogfood scan
recognizes 12 non-fixture daemon HTTP entries. Execution-flow schema v4 gives
every path a typed terminal outcome and presents loop/switch handling as
incomplete gaps rather than fabricated expansion.

Only the standalone `GET /api/search` fixture is scored through the
provider-neutral EVAL-001 precision/recall report. Switches, loops, uncaught
exceptions, interprocedural non-response effects and broader formal path
evaluation remain outside that scored oracle.
→ [decision](DECISIONS.md#first-flow-001-production-slice)

**Task-context query** (QUERY-001, **experimental**). `brief` accepts a task, optional targets,
intent and an exact UTF-8 byte budget; no 34th MCP tool was added. A Rust planner
beside the native SQLite owner resolves targets without guessing, combines the
shared FTS5 index with bounded one-hop reference/import, execution-flow,
authored-flow, finding, memory, relation, exported-surface and test evidence, and
emits deterministic scores with reasons and provenance. The former
TypeScript-only ranking implementation was removed while its single-target call
remains compatible. This path reports itself as experimental: broader corpus
coverage and downstream task outcomes remain open before QUERY-001 can be called
proven, or before any redundant public tool is retired.

**Measured retrieval ranking** (QUERY-001, **experimental**). All reviewed evidence is retrieved in
both first-corpus tasks. Review recall@5 is 0.5; debug recall@4 is 0.75. Both
have zero irrelevant returned paths and use less than 1.5× the map's actual
tokens. The Rust ranker removes the selected intent from lexical subject terms,
rewards independent corroborating signals, and applies a bounded repeated-path
penalty.

**Change-aware retrieval** (QUERY-001, **experimental**). A bounded async Rust adapter consumes
Git's porcelain v2 status instead of implementing a diff engine. It distinguishes
clean, non-repository and unavailable states, resolves nested workspace roots,
rejects escaping and non-UTF-8 paths, bounds status to 30 s, 2 MiB and 256
normalized changes, clears inherited repository selectors, and merges multiple
porcelain records for one path without discarding staged state. The planner
preserves explicit targets ahead of unrelated dirty files, prioritizes indexed
changes before its 24-path graph-expansion cap, and treats pre-refresh deletes
and renames as stale historical evidence; it distinguishes current, historical,
absent and omitted change context. A clean-baseline fixture scores 1.0 recall and
coverage with zero irrelevant paths. QUERY-001 remains experimental — the next
proof work is a broader multi-project, multi-language corpus.

**Retrieval evaluation corpus** (EVAL-001). The ordinary evaluation command runs
task-context scenarios against a digest-pinned artifact generated by real
Aider 0.86.2 output. A strict checked-in oracle measures recall at K, reviewed
evidence coverage, irrelevant-path rate, response bytes and exact `o200k_base`
tokens without installing Aider in normal CI. Both sides stay inside a shared
1,600-token band. Tightened regression floors pass, but promotion remains
explicitly blocked on a broader corpus and downstream task outcomes.

**First flow and search workspaces** (UI-001). The desktop has a global search
workspace over the shared FTS5 index and a first entry-to-effect flow workspace.
Flow steps, call-graph nodes, symbols, findings, entries and resolved call
targets open bounded source slices at their indexed ranges. The desktop compares
current source signatures with each selected evidence generation and visibly
marks stale or unattested evidence. Resolved execution targets carry their exact
declaration range from the Rust reference index rather than a same-named-symbol
guess.

## 2026-08-11

**Rust owns inventory and syntax.** The weaker TypeScript repository walker and
WASM parser fallback were retired after the Rust core reached every supported
desktop target and produced better reference facts. Rust owns the single
production source inventory, classification, hashing and syntax boundary. A
missing platform binary is reported as a broken installation rather than
silently changing fact coverage.

**First TypeScript fixture and harness** (EVAL-001). The first checked-in fixture
covers a cross-file call, condition, early return, throw, await and terminal HTTP
response. `npm run eval` runs the native scanner, the native scanner plus
TypeScript checker prototype, and the SCIP provider in isolated workers, emitting
targeted symbol/reference precision and recall, cold/warm/one-file-change timing,
store and artifact size, worker peak RSS, missing facts and threshold failures.
CI pins the official SCIP v0.9.0 binary and reuses its golden-test format and
validator rather than reimplementing occurrence truth.

**Python slice** (EVAL-001). Oracle schema v2 declares languages and applicable
providers and enforces matching per-provider thresholds. A LangGraph fixture
records one manifest entrypoint, thirteen framework/effect relations and four
expected paths. The native scanner measures 9/9 selected symbols and 8/9
references; evaluation-only SCIP-Python 0.6.6 measures 9/9 for both and passes
upstream `scip test`, but emits no flow relationships.

**Joern slice** (EVAL-001). An opt-in, digest-pinned, network-disabled Joern
container evaluation consumes the official Python CPG and GraphSON export. A
narrow LangGraph adapter scores 12/13 relations at 1.0 precision / 0.923077
recall and 3/4 exact relation-sequence paths at 1.0 precision / 0.75 recall. The
missing relation is deliberately the human-asserted result-store boundary. The
2.17 GB extracted AMD64-only image and full-GraphSON translation fail packaging
criteria, so Joern remains evaluation-only.

## 2026-08-10

**Bounded SCIP evaluation path** (PROV-001). The app bundles the maintained SCIP
TypeScript indexer, supervises bounded evaluation runs, decodes and hashes
indexes in Rust, stores manifests outside source repositories, reports
capabilities in the desktop, and preserves Tree-sitter fallback. Rust copies the
exact indexed source generation into a private app-owned view, rejects a
generation mismatch, records every staged input and hash, verifies that view
after the provider exits, and reports retained output as stale after the source
signature changes. Dependencies and other compiler reads outside that view are
not attested, so evaluation stays partial and unverified. Configless evaluation
uses an app-owned config rather than letting the upstream CLI write a
`tsconfig.json` into the workspace — the upstream `--infer-tsconfig` flag is
never invoked.

Provider discovery, execution and decode waits all honour removal and shutdown
cancellation, so a workspace can be removed or the daemon stopped without
waiting on an external indexer. A successful index that skipped some requested
project configs stays inspectable but is explicitly labelled `partial` rather
than reported as a complete success.

**Fact, edge and provenance envelope v1** (INT-001). Schema version 1 defines the
minimum producer, generation, ownership, certainty, freshness, evidence,
endpoint, node and edge envelope plus the initial relation vocabulary. Existing
files, symbols, imports, references and authored relations project into it
without replacing their prototype tables; missing legacy import ranges and
unresolved endpoints remain explicit. Official SCIP occurrences and relationships
project through the same envelope with durable workspace/run validation.

## 2026-08-06

**Architecture correction.** The existing TypeScript enrichment is a prototype,
not a production semantic-indexing foundation. A bespoke expansion of its
project-resolution and freshness machinery was removed before commit. Future
precise references and deeper program analysis follow the
[provider-first strategy](PROVIDER_STRATEGY.md).

**Map runner tool loading** (SEM-001). The Claude map runner eagerly loads only
the allowlisted SDLC MCP tools even when built-in tools are disabled. A
previously interrupted 75% map resumed to 98% coverage, and maintenance refreshed
six drifted components without rebuilding clean work. Finalization rejects stale
retained components or flows, and the supervisor distinguishes initial drawing
from maintenance completion.

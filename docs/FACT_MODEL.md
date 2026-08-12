# Provider-neutral fact contract

Status: schema version 1, introduced 2026-08-10.

## Purpose and boundary

SDLC imports facts from maintained analyzers; it does not replace their language
semantics. SCIP remains the native representation for precise symbol navigation,
and CPG/compiler/runtime formats retain their provider-specific detail. This
contract is the small envelope SDLC needs to combine those results without
making parsed, compiler-resolved, inferred, observed, human, and LLM claims look
equivalent.

Raw SCIP was not adopted as the universal model because it intentionally
focuses on symbols and occurrences; it cannot represent runtime observations,
human decisions, inferred framework dispatch, or terminal effects. A full CPG
was not adopted as the universal storage contract because it adds a much larger
AST/control/data-flow schema than the current product queries require. Provider
ids and native kinds are preserved so SDLC does not flatten away either format.

The executable TypeScript contract is
[`packages/engine/src/facts/model.ts`](../packages/engine/src/facts/model.ts).

## Required envelope

Every node and edge carries:

- `schemaVersion`, stable fact id, workspace id, and creation time;
- producer id, version, and method (`parsed`, `compiler`, `framework`,
  `runtime`, `human`, or `llm`);
- source and optional exact provider-input signatures plus a run id; an older
  legacy fact whose producing source generation was never recorded uses a null
  source signature and must remain `unverified`;
- an ownership scope identifying the unit a producer may replace;
- a certainty class (`exact`, `inferred`, `observed`, `asserted`, `ambiguous`,
  or `unknown`);
- freshness (`current`, `stale`, or `unverified`) relative to that generation;
- evidence with a zero-based, half-open source anchor, or an explicit reason a
  navigable source range is unavailable.

Provider-native ids and kinds remain optional fields on neutral entities. They
are provenance and round-trip information, not global SDLC identity.

## Initial relation vocabulary

Version 1 recognizes containment, imports, references, calls, returns,
branches, throw/catch, await/resume, register/dispatch, reads/writes,
emit/handle, implementations, configuration, and terminal effects. A provider
may retain a more specific native relation alongside this coarse query kind.

An unresolved endpoint is represented as an entity reference with
`unresolvedReason`; it is never replaced by a guessed node. Confidence on an
authored assertion does not promote its certainty above `asserted`.

## Compatibility and migration

- Additive optional fields and vocabulary values are backward-compatible within
  a schema version.
- Removing fields, changing range coordinates, changing certainty semantics, or
  reinterpreting ownership requires a schema-version increment.
- Adapters declare which schema version they produce. Unsupported versions are
  rejected rather than partially interpreted.
- Provider-owned facts are replaced by ownership scope and generation; they are
  not updated one row at a time across incompatible runs.
- Provider-native artifacts remain available for re-import. The neutral store is
  derived data and may be rebuilt after a migration.

## Prototype projection

[`packages/engine/src/facts/legacy.ts`](../packages/engine/src/facts/legacy.ts)
projects the existing files, symbols, imports, references, and authored
relations without changing their authoritative tables. It deliberately records
that legacy import edges lack source ranges, keeps import-resolved references
`inferred`, keeps compiler-resolved references distinct, and keeps agent
relations `asserted`. A successful legacy compiler pass records the indexed
workspace generation and deterministic source signature for each source file
whose references it replaced;
projected compiler facts are `stale` after a source or project-coverage change.
While that repository generation still matches they remain `unverified`, not
`current`, because the prototype does not attest TypeScript's full dependency,
package-config, standard-library, and out-of-tree input closure. Older stores
without a recorded producing generation are also `unverified`.
Compiler reference and compiler-only declaration ranges use the UTF-8 byte
coordinates stored by the typed prototype, including the actual source token
end for escaped identifiers. Older and parser-derived reference rows that did
not preserve an end coordinate remain navigable by file/symbol but omit an
invented range. Shared compiler-only declarations are grouped before projection
so their freshness does not depend on source-row order.

Legacy authored relations retain their authored-artifact generation through the
relation update timestamp. They use a null source signature and remain
`unverified` while their source anchor matches, or `stale` after it changes,
rather than borrowing the source generation present when they are projected.

## Official SCIP projection

[`packages/scan-core/src/provider.rs`](../packages/scan-core/src/provider.rs)
uses the official SCIP Rust bindings to decode a bounded artifact, preserve
document position encodings and relationship flags, scope local symbol ids to
their owning document, deduplicate overlapping project output, and mark
conflicting targets at the same source range ambiguous. Conflicting same-path
provider documents retain separate local-symbol scopes instead of silently
merging reused local ids. Raw semantic records and unique projected facts are
bounded before and during collection. Document paths are rebased only after the
SCIP project root is proven to be the exact staged input root; portable parent
escapes, documents absent from the durable input manifest, and internally
inconsistent input manifests are rejected. Canonical document spelling is
captured before the staged tree is removed, so case aliases remain tied to one
collision-free manifest identity on case-insensitive filesystems. The ordered
alias map has its own run-bound digest, which is verified before replay.
File-URI conversion uses the maintained `url` crate, including Windows UNC
roots; an untrusted UNC authority is rejected before filesystem access, and
validated roots are canonicalized once per projection. The projection is also
rejected if its artifact digest no longer matches the run manifest.

[`packages/engine/src/facts/scip.ts`](../packages/engine/src/facts/scip.ts)
shapes those native facts into schema version 1. Definitions become symbol
nodes and containment edges; occurrence roles become import, reference, read,
or write edges; and SCIP relationship flags retain their native kind alongside
the coarse reference/implementation vocabulary. Facts are owned by the
provider run and retain its source, input, and run generation. Current output
remains `unverified` because the evaluation does not yet attest the compiler's
complete dependency/read closure; a later repository generation makes it
`stale`. Projection requires the current indexed generation and validates the
durable run's workspace owner; caller-supplied DTO fields cannot relabel or
promote a run. SCIP TypeScript 0.4 omits its document position encoding, so those
anchors remain `unknown` rather than assuming UTF-16.

This is still a measured import boundary, not persisted production provider
facts. STORE-001 now supplies app-owned native SQLite with direct transactional
writes; the next fact-model persistence step should store provider-run
ownership there without flattening provenance or freshness into legacy tables.

## Deterministic execution-path projection

Schema v19 persists the first production framework-adapter graph in
`execution_entries`, `execution_nodes`, `execution_edges`, and
`execution_diagnostics`. These rows remain separate from the human/LLM-authored
`flows` overlay. Each entry records its framework producer/version, `inferred`
certainty, source evidence, file-owned replacement scope, and input content
hash; query freshness compares that hash with the current indexed file.

Schema v20 records the execution target's local source spelling and exact
line/column occurrence separately from its resolved destination path and
symbol. Reference providers can refresh the destination after syntax or typed
resolution without losing aliases, default imports, or evidence identity. A
compiler-derived destination is exposed only while its recorded workspace
generation matches the current indexed generation; during refresh lag the call
returns to an unresolved local spelling rather than presenting a stale target.

The native graph uses a private `next` edge for bounded path ordering. `next`
is not silently promoted into the version-1 fact vocabulary. Evaluation and
agent responses project meaningful operations into the existing `register`,
`call`, `branch`, `catch`, `await`, `return`, `throw`, and `terminal-effect`
relations, while keeping sequence edges as presentation/CFG detail. Unsupported
control constructs become explicit gap nodes with diagnostics rather than
fabricated fact edges.

Execution-flow response schema v2 adds an optional `assertedOverlay` beside the
deterministic nodes, edges, and paths. It is disabled by default. When enabled,
the native query returns only authored relations whose evidence-source file is
still present and has the same indexed content hash recorded when the relation
was written. Every relation remains labeled `asserted`, retains its confidence
and evidence, and identifies the deterministic nodes it touches. Overlay rows
never alter path completeness, certainty, terminal effects, or deterministic
graph structure; stale assertions remain available through the relations query
for review but are not presented as current execution context.

Execution-flow response schema v3 makes call-target resolution explicit on
every node. A `call` or `await` without a resolved destination is returned as
`resolution: unresolved`, contributes to the entry's gap count, emits a source-
anchored diagnostic, and makes each path that traverses it incomplete. Resolved
calls, external effects, and nodes for which resolution does not apply remain
distinct states. The query does not guess a same-file or member-call target from
its spelling merely to make a path look complete.

Execution-flow response schema v4 adds one `terminalOutcome` to every enumerated
path while retaining `terminalEffect` for compatible effect-only consumers. The
outcome distinguishes a recognized external effect, an ordinary return, an
uncaught throw, and an explicit analysis gap. A path that is bounded before a
terminal node receives a synthetic gap outcome instead of an unexplained null.
Return and throw nodes use `resolution: not-applicable`; their `return` and
`exception` markers describe control outcomes, not resolved external targets.

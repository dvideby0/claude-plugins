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
- source and optional exact provider-input signatures plus a run id;
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
workspace generation for each source file whose references it replaced;
projected compiler facts are `current` only while that generation still
matches, `stale` after a source or project-coverage change, and `unverified`
for older stores that have no attestation.
Compiler reference ranges use the UTF-8 byte coordinates stored by the typed
prototype. Older and parser-derived reference rows that did not preserve the
local token end remain navigable by file/symbol but omit an invented range.

The next provider slice projects official SCIP occurrences and relationships
into the same envelope for measured comparison. Persistence waits for
STORE-001's app-owned native SQLite boundary so a large provider index is not
first written into the disposable whole-export `sql.js` store.

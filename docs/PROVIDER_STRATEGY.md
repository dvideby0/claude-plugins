# Provider-first code intelligence

Status: architecture decision, 2026-08-06.

## Decision

SDLC will orchestrate and combine proven code-intelligence providers instead of
reimplementing their language-specific semantic analysis.

In particular, the engine must not grow its own production TypeScript project
resolver, package resolver, compiler-reference indexer, universal control-flow
graph, or universal data-flow engine when a maintained provider can supply that
information. The existing TypeScript enrichment remains prototype capability;
it is not the foundation for deeper analysis.

The initial provider stack is:

1. The bundled Rust and Tree-sitter scanner supplies fast, resilient syntax,
   repository inventory, and a useful fallback when precise providers cannot
   run.
2. [SCIP](https://github.com/sourcegraph/scip) indexes supply precise semantic
   symbols, definitions, references, implementations, and cross-file identity
   where a maintained language indexer exists.
3. [Joern](https://github.com/joernio/joern) and its
   [Code Property Graph](https://docs.joern.io/code-property-graph/) are evaluated
   as an optional provider for control-flow, data-flow, and program-analysis
   overlays before SDLC implements those representations itself.
4. Compiler APIs, language servers, CodeQL databases, coverage, and runtime
   traces may be added through the same provider boundary when they contribute
   capabilities not covered by the first three layers.

Kythe's schema and partial-information rules remain useful design references,
but adopting its distributed indexing pipeline is not required for a local
desktop product.

## What SDLC owns

SDLC's differentiated work is the product and knowledge-fusion layer:

- packaging, supervising, and updating local providers;
- workspace registration, snapshots, provider capabilities, and health;
- a small provider-neutral envelope for identity, source anchors, evidence,
  producer/version, snapshot, certainty, and staleness;
- preserving deterministic, inferred, runtime, human, and LLM knowledge as
  distinguishable layers;
- merging, querying, ranking, and explaining facts from multiple providers;
- the desktop workflows for search, source navigation, flows, corrections,
  memories, and change understanding;
- budgeted context delivery through MCP and supported Claude/Codex connectors.

The versioned minimum envelope is documented in
[`FACT_MODEL.md`](FACT_MODEL.md). Provider-native SCIP and CPG detail remains
available behind that boundary rather than being reimplemented in the envelope.

SDLC does not own language package-resolution edge cases, compiler-grade symbol
identity, or mature universal program-analysis algorithms. Provider adapters
translate those results into SDLC's envelope without pretending SDLC produced
the underlying fact.

## Snapshot and trust rule

Precise provider output belongs to the exact source snapshot and provider
version that produced it. A working tree that no longer matches that snapshot
does not trigger ad hoc reinterpretation of the old result as current and exact.
The result is marked stale or unavailable until the normal pipeline refreshes
the syntax index and then the dependent provider output.

An index file alone is not proof of that snapshot. For output to be classified
as exact, the SDLC provider runner must execute the provider against an
immutable, app-owned staged snapshot (or an input view with equivalent read
attestation and mutation fencing) that includes every byte the provider may
read, including dependency declarations and out-of-tree project inputs. It records the staged inputs, provider
identity and version, and output digest in a run manifest. Comparing that
manifest's source signature with the live workspace determines whether the
result is current or stale; matching live-workspace hashes at two points in
time is not proof that a provider never observed intermediate bytes. A prebuilt
index imported without equivalent verifiable provenance is useful for
evaluation, but remains unverified and must never be labeled current and exact.

This snapshot boundary is deliberately simpler than attempting to duplicate a
compiler's complete input dependency graph inside the query path.
The current SCIP evaluation attests only the deterministic repository source
view. Because the external process is not yet confined to a manifested
dependency/read closure, its useful comparison output remains `partial` and
`unverified`; source staging alone is not described as exact provenance.

## Adoption sequence

1. Build the EVAL-001 golden corpus before choosing providers by reputation.
2. Add a narrow provider runner and capability manifest.
3. Import one SCIP index for this repository and compare it with the current
   reference prototype.
4. Run a bounded Joern spike against entry-to-effect fixtures and measure the
   usable coverage, packaging cost, latency, and graph translation effort.
5. Keep, replace, or supplement providers based on measured gaps. Write custom
   analyzers only for product-specific relations or proven provider gaps.

## Implementation status

As of 2026-08-06, the first evaluation boundary exists:

- the official `@sourcegraph/scip-typescript` 0.4.0 indexer is bundled for
  TypeScript and JavaScript evaluation;
- the app runs it under the existing bounded process supervisor and writes its
  output and manifest under app-owned provider storage;
- the Rust native core decodes the official SCIP protobuf, applies a bounded
  input limit, hashes the artifact, deduplicates documents emitted by
  overlapping project configs for comparison, and returns aggregates;
- the same official decoder now exposes a bounded occurrence/relationship
  projection into the shared fact envelope. It verifies the retained digest,
  recomputes the durable input manifest, binds the run to its workspace and
  exact staged project root, confines portable document paths, bounds raw and
  projected records, scopes conflicting local symbols safely, and preserves
  ambiguous targets and unknown position encodings rather than guessing. It
  digest-binds collision-safe manifest spelling for case aliases and accepts
  local Windows UNC file roots through the maintained Rust URL implementation
  after a pre-I/O authority check;
- configless JavaScript/TypeScript evaluation uses an app-owned config built
  from the deterministic source inventory; it never invokes the upstream
  `--infer-tsconfig` mode that writes into the source repository;
- Settings reports provider capabilities and the project Overview can run and
  inspect a SCIP comparison without replacing the existing syntax facts;
- the Rust core stages the deterministic source inventory under app ownership,
  requires it to match the indexed source signature, records a hash manifest,
  and verifies the input view after SCIP exits; dependency and out-of-tree
  compiler reads remain unattested, so current output is partial/unverified,
  later source generations expose it as stale, and only the five most recent artifacts remain;
- provider discovery, execution, and decode waits honor removal/shutdown
  cancellation, while successful indexes with skipped project configs remain
  inspectable but are explicitly labeled `partial`;
- both `tsconfig.json` and `jsconfig.json` are discovered; invalid configs,
  oversized-source skips, and mixed valid/invalid project sets are surfaced as
  failed or partial instead of silently appearing complete, and flag-like legal
  project paths are passed as paths rather than CLI options;
- config preflight is bounded and syntax-only; it does not expand TypeScript
  globs on the daemon thread, and solution-style roots remain intact so the
  provider can follow custom-named project references itself;
- Joern capability detection exists, but no Joern adapter is enabled or bundled
  yet. Its first use remains the bounded EVAL-001 control/data-flow spike.

This completes attestation of the repository source view, not full immutable
provider-input provenance or PROV-001. Dependency/read-closure confinement,
evaluation across the full golden corpus, native fact persistence, and broader
query adoption remain open.

## Guardrails

- Search for mature, battle-tested implementations before designing a custom
  subsystem. Adopt a strong option when its behavior, maintenance, security,
  packaging, and license fit the product. Document the reason when declining an
  obvious candidate.
- Check for a maintained SCIP, compiler, language-server, or CPG provider before
  implementing a language's precise semantic analysis.
- A provider integration must declare capabilities and degradation behavior.
- Provider failures must leave syntax search and desktop navigation usable.
- Do not expose provider output as exact after its source snapshot changes.
- Do not infer provenance from the workspace present when a prebuilt index is
  imported; require a matching run manifest or classify the result as
  unverified.
- Do not run an exact provider directly over a mutable working tree. Stage or
  otherwise fence every input the provider can read.
- Do not bundle a heavyweight provider until an evaluation demonstrates value
  for a named user workflow.
- Custom framework adapters are appropriate when they add SDLC-specific
  entrypoint, dispatch, or terminal-effect meaning on top of provider facts.

## Implementation language

New app-owned engine, indexing, storage, orchestration, and background-runtime
code should be written in Rust by default. Rust aligns with the standalone
packaging boundary and avoids making users supply a compatible JavaScript
runtime for core behavior.

TypeScript remains appropriate for Electron UI code, thin Claude/Codex or MCP
integration surfaces, and APIs whose maintained ecosystem is materially better
in JavaScript. This is a decision rule for new work, not a mandate to rewrite
working TypeScript without a measured product or operational benefit.

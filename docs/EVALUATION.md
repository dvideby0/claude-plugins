# Code-intelligence evaluation

Status: executable symbol/reference and retrieval corpora, measured HTTP flow
slice, and bounded Joern flow spike, 2026-08-12.

## Purpose

Provider choice and product claims must be based on checked-in evidence rather
than aggregate index counts. Each fixture declares its languages and applicable
providers, and the evaluation command runs only those pipelines. The current
TypeScript fixture compares the native Tree-sitter scanner, native scanner plus
the existing TypeScript checker prototype, and official SCIP TypeScript
provider. The Python/LangGraph fixture compares the native scanner with pinned
`@sourcegraph/scip-python` 0.6.6. Each pipeline is
isolated in its own process and scored through the same provider-neutral fact
envelope. The checker pipeline only scores resolved references produced for the
measured checker generation; it cannot receive credit for native baseline
references or stale compiler rows.

Run the current corpus with:

```bash
npm run --silent eval -- --json
```

CI additionally supplies the pinned official SCIP v0.9.0 CLI and requires its
[`scip test`](https://github.com/scip-code/scip/blob/v0.9.0/docs/CLI.md#scip-test)
golden assertions to pass. A local installation is detected automatically, or
can be selected explicitly:

```bash
npm run --silent eval -- --require-scip-cli --scip-cli /path/to/scip
```

## What is measured now

Each versioned `oracle.json` names a deliberately bounded symbol and reference
domain. Predictions with those names and source paths are compared by stable,
provider-neutral keys; repeated provider occurrences are deduplicated. The
report includes true/false positives, missing facts, precision, recall, F1,
checked-in regression thresholds, cold/warm/one-file-change timings where the
provider supports them, workspace-store size, provider-artifact size, isolated
worker peak RSS, and enforced SCIP document/definition/reference bounds.

Exact SCIP occurrence ranges are not reimplemented by SDLC. Fixture source
uses the upstream
[`scip test` file format](https://github.com/scip-code/scip/blob/v0.9.0/docs/test_file_format.md),
and CI executes the official binary against the index. SDLC's scorer covers the
separate product question: whether facts imported from different providers
normalize to the expected symbol and resolved-reference relations.

The current oracle is targeted, not an exhaustive claim about every local or
standard-library symbol. A provider can only be compared for facts explicitly
inside the selected domain.

The same command discovers strict retrieval oracles under
`packages/engine/fixtures/retrieval`. Those scenarios run the real budgeted
`brief` pipeline against a copied, freshly indexed fixture and compare it with
a checked-in map produced by pinned Aider 0.86.2. Source-tree and normalized
artifact SHA-256 digests make a stale baseline a hard error. The scorer reports
path recall at K, reviewed evidence coverage, irrelevant-path rate, complete
pretty-JSON bytes, and exact `o200k_base` tokens through pinned
`js-tiktoken` 1.0.21. It does not reimplement Aider's graph ranking.
Top-level report schema version 2 keeps provider scenarios and retrieval
scenarios in separate fields and includes both in the final pass/fail summary.

Oracle schema version 2 can also record reviewed entrypoints, relations,
terminal effects, conditions, and complete entry-to-effect paths. The ordinary
evaluation command scores that truth for providers explicitly listed in the
oracle's `measuredProviders`. A required provider that emits no candidate graph
fails the declared thresholds; providers without a product adapter remain
explicitly `unmeasured` and are rejected from `measuredProviders`. Merely
checking flow truth into the repository, or running a separate provider beside
the native adapter, does not grant that provider path credit.

The TypeScript HTTP fixture exercises an explicit route guard, a caught
exception, an `if` branch, an awaited cross-file call, and three terminal HTTP
response paths. The bounded Rust HTTP adapter finds its one entrypoint, eight
unique semantic relations (nine evidence-bearing occurrences), and all three
paths at 1.0 precision/recall with matching evidence anchors. Repeated semantic
relations consume evidence occurrences one-to-one, so one source location
cannot satisfy multiple reviewed anchors. Branch-condition equivalence, runtime
feasibility, and data-value propagation remain explicitly unmeasured. These are
fixture results, not a broad TypeScript CFG claim.

A separate checked-in dogfood regression scans this repository's real daemon
source rather than a copied fixture. It fixes expected branch/response paths,
evidence, provenance, and target-resolution states for `GET /api/search`,
`ANY /api/watch`, and `POST /api/workspaces`. Unresolved local or member calls
are expected gaps and make only the paths that traverse them incomplete. This
is a product regression gate, not an additional precision/recall result: the
provider-neutral JSON report continues to claim measured path quality only for
the oracle-backed fixture above.

The separate opt-in Joern spike does score that reviewed flow truth. It uses
Joern's official Python frontend and official GraphSON exporter, then applies a
narrow LangGraph adapter. CPG-resolved calls, framework-inferred dispatch, the
deterministically parsed deployment manifest, and human-authored terminal-
effect knowledge remain visibly different producers/certainty classes.
Flow precision/recall floors live beside the reviewed truth in the checked-in
oracle. The command exits nonzero when those floors, source-evidence checks, or
adapter-completeness checks fail; desktop packaging failures remain an explicit
adoption decision rather than making the measurement command itself fail.

## Current Python result

The small Python fixture is LangGraph-shaped and inspired by Agent Arena; it is
not a claim that the full Agent Arena repository has been indexed. It records
one manifest entrypoint, thirteen framework/effect relations, and four expected
entry-to-effect paths. The additional reviewed relation/path records successful
LangGraph completion separately from the asserted application persistence
effect. On the selected nine-symbol/nine-reference domain:

- the native scanner finds 9/9 symbols and 8/9 references, missing the
  same-file `build()` reference;
- SCIP-Python finds 9/9 symbols and 9/9 references and passes official
  upstream `scip test` assertions, but emits no framework, CFG, or
  entry-to-effect relationships.

SCIP-Python is therefore pinned as an evaluation-only development dependency,
not promoted into the desktop or production provider catalog. The runner gives
it a deterministic empty environment description, preventing its package-
environment discovery phase from enumerating installed packages. This is not a
filesystem sandbox. Its precise-reference benefit is real, but its Pyright fork
and older transitive dependencies make it a weaker long-term production choice
than an actively maintained compiler/CPG path.

## Current retrieval result

The first retrieval corpus is a small TypeScript checkout domain with 18 source
files, two config files, one reviewed authored constraint, and two task-only
queries in a shared 1,600-token comparison band. Aider is generated with that
map target; SDLC's 6,000-byte ceiling produces fewer than 1,600 measured tokens
for both scenarios. The comparison artifact is the actual output of Aider's maintained
[repository map](https://aider.chat/docs/repomap.html), not an SDLC imitation.
It occupies 4,063 bytes and 982 `o200k_base` tokens.

For `review submitCheckout inventory reservation`, SDLC scores 0.166667 path
recall@5 and covers 1/3 required evidence; Aider scores 0.333333 and 3/3. SDLC
returns only the relevant checkout path, while Aider exposes fourteen
irrelevant paths among twenty (0.7). SDLC's complete response uses 5,635 bytes
and 1,582 tokens, 1.610998 times the baseline token count. The missing reviewed
items are the inventory declaration and covering checkout test.

For `debug checkout idempotency requirement`, SDLC scores 0.5 path recall@4,
2/3 evidence coverage, and no irrelevant returned path. Aider scores 0.25,
2/3, and 0.8 respectively. The equal evidence counts contain different facts:
SDLC retrieves the authored constraint but misses `recordCheckout`; the symbol
map retrieves `recordCheckout` but cannot contain the constraint. SDLC uses
5,798 bytes and 1,588 tokens, 1.617108 times the Aider artifact.

These measurements clear checked-in regression floors, but they do not promote
QUERY-001. The corpus explicitly blocks promotion until change relevance and a
broader multi-project/language sample are measured. The result also makes the
next optimization concrete: improve review/test coverage and reduce response
duplication before claiming the focused package is better than the cheap repo
map. The source packer now avoids spending a tight budget on overlapping
excerpts from one path, then restores those excerpts in rank order when a
larger budget has room.

To run only one retrieval fixture while retaining the provider corpus:

```bash
npm run --silent eval -- --retrieval-fixture typescript-checkout
```

Provider-only diagnostics can opt out explicitly with `--skip-retrieval`.

## Bounded Joern result

Joern remains opt-in and is not run by the ordinary build, test, or evaluation
commands. Pull the exact reviewed image explicitly, then run the spike:

```bash
docker pull ghcr.io/joernio/joern-slim@sha256:29eb685a95dc1db5a729043d8b5fc8f888f7c03ec6f1a8810736df62161f4b98
npm run --silent eval:joern -- --json
```

The evaluator refuses mutable image tags. It copies the fixture to an app-owned
temporary input, mounts it read-only, disables networking, drops Linux
capabilities, enables no-new-privileges, bounds CPU/memory/PIDs/output, and
removes its CPG and GraphSON artifacts afterward. Joern never receives the
working repository as writable input.

On the 2026-08-11 Apple Silicon development run, the pinned Apache-2.0 slim
image produced a 135,253-byte CPG and a 3,783,570-byte GraphSON export with 724
vertices and 4,301 edges. Under x86 emulation, parse took 8.03 seconds, export
3.17 seconds, and SDLC translation/scoring 26 milliseconds. These are one-run
spike measurements, not stable performance claims.

Joern plus the narrow adapter found the one entrypoint, 12/13 reviewed
relations (precision 1.0, recall 0.923077), and 3/4 exact relation-sequence
paths (precision 1.0, recall 0.75). The only missing relation and path depend on
the reviewed `persist_result -> result-store` assertion; the function body does
not contain a deterministic storage operation, so the evaluator correctly does
not invent one. Nine framework relations retain `inferred` certainty even
though they match reviewed truth marked `exact`.

This clears the predeclared flow-coverage floor, but does **not** justify
bundling Joern. The tested image occupies 2,167,932,743 extracted bytes, is
AMD64-only while the test host is ARM64, and the tested slim image failed even
Joern's documented minimal batch-script pattern. The spike therefore requires
a bounded full GraphSON export that is roughly 28 times the fixture CPG size.
Joern stays an evaluation/reference provider while SDLC tests whether the same
product-specific LangGraph semantics can sit on the already adopted native and
SCIP facts.

## What remains unmeasured

The JSON report explicitly labels gaps instead of encoding unavailable
measurements as zeros:

- entry-to-effect path precision and recall outside the one opt-in
  Python/LangGraph Joern scenario and the measured TypeScript HTTP adapter;
- retrieval change relevance, downstream task/answer quality, and quality
  outside the first TypeScript checkout fixture;
- warm and one-file-change SCIP indexing;
- peak RSS of the external SCIP child process.

Additional fixtures must expand the oracle before any Joern/CPG production
adoption or broad FLOW-001 precision claim. The first HTTP case now covers one
condition, caught exception, await, registration pattern, and response effect;
callbacks, events, database/filesystem effects, overloads, and unresolved
dynamic behavior still need independently reviewed cases. Explicit returns,
uncaught throws, loops, and switches have an end-to-end native-query regression,
but that is contract coverage rather than provider-neutral precision/recall
evidence. Loop iteration and switch-case expansion remain unimplemented and
unmeasured.

## Adding a fixture

Create a directory under `packages/engine/fixtures/eval` containing its source,
build metadata, and a strict schema-version-2 `oracle.json`. Declare languages,
applicable providers, selected symbols, resolved references, a harmless
one-file-change probe, and exactly one threshold block per selected provider.
SCIP providers also require count bounds, source comment syntax, and official
test files. Add reviewed `entryToEffect` truth when the fixture exercises flow.
The command discovers the fixture automatically. CI fails when the schema,
thresholds, count bounds, or official SCIP assertions regress.

For retrieval, create a directory under `packages/engine/fixtures/retrieval`
with `source/`, a strict schema-version-1 `oracle.json`, and a normalized
baseline artifact. Generate the baseline from an isolated Git copy of the
source so Aider cannot write history or ignore files in the fixture. The first
fixture used this pinned command:

```bash
uvx --python 3.12 --from aider-chat==0.86.2 aider \
  --show-repo-map --map-tokens 1600 --model gpt-4o-mini \
  --no-show-model-warnings --no-check-update --analytics-disable --no-gitignore \
  --chat-history-file /tmp/sdlc-aider-1600-chat.md \
  --input-history-file /tmp/sdlc-aider-1600-input.md \
  --llm-history-file /tmp/sdlc-aider-1600-llm.md
```

Remove only Aider's CLI preamble, normalize line endings to LF and trailing
whitespace, then record both source-tree and artifact digests in the oracle.
Normal CI consumes that artifact and does not install Aider's Python runtime.

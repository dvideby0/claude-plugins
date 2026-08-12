# Code-intelligence evaluation

Status: executable symbol/reference corpus, measured HTTP flow slice, and
bounded Joern flow spike, 2026-08-12.

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

Oracle schema version 2 can also record reviewed entrypoints, relations,
terminal effects, conditions, and complete entry-to-effect paths. The ordinary
evaluation command now scores that truth only when a production adapter emits a
candidate graph for the fixture; otherwise it remains explicitly `unmeasured`.
Merely checking flow truth into the repository does not grant a provider path
credit.

The TypeScript HTTP fixture exercises an explicit route guard, a caught
exception, an `if` branch, an awaited cross-file call, and three terminal HTTP
response paths. The bounded Rust HTTP adapter finds its one entrypoint, seven
unique semantic relations (eight evidence-bearing occurrences), and all three
paths at 1.0 precision/recall with matching evidence anchors. Branch-condition
equivalence, runtime feasibility, and data-value propagation remain explicitly
unmeasured. These are fixture results, not a broad TypeScript CFG claim.

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
- retrieval recall at K, evidence coverage, token packing, and irrelevant
  context rate;
- warm and one-file-change SCIP indexing;
- peak RSS of the external SCIP child process.

Additional fixtures must expand the oracle before any Joern/CPG production
adoption or broad FLOW-001 precision claim. The first HTTP case now covers one
condition, caught exception, await, registration pattern, and response effect;
callbacks, uncaught exceptions, loops/switches, events, database/filesystem
effects, overloads, and unresolved dynamic behavior still need independently
reviewed cases.

## Adding a fixture

Create a directory under `packages/engine/fixtures/eval` containing its source,
build metadata, and a strict schema-version-2 `oracle.json`. Declare languages,
applicable providers, selected symbols, resolved references, a harmless
one-file-change probe, and exactly one threshold block per selected provider.
SCIP providers also require count bounds, source comment syntax, and official
test files. Add reviewed `entryToEffect` truth when the fixture exercises flow.
The command discovers the fixture automatically. CI fails when the schema,
thresholds, count bounds, or official SCIP assertions regress.

# Code-intelligence evaluation

Status: first executable EVAL-001 slice, 2026-08-11.

## Purpose

Provider choice and product claims must be based on checked-in evidence rather
than aggregate index counts. The evaluation command runs every fixture through
the TypeScript fallback scanner, native Tree-sitter scanner, the native scanner
plus existing TypeScript checker prototype, and official SCIP TypeScript
provider. Each pipeline is isolated in its own process and scored through the
same provider-neutral fact envelope. The checker pipeline only scores resolved
references produced for the measured checker generation; it cannot receive
credit for native baseline references or stale compiler rows.

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

## What remains unmeasured

The JSON report explicitly labels gaps instead of encoding unavailable
measurements as zeros:

- entry-to-effect path precision and recall;
- retrieval recall at K, evidence coverage, token packing, and irrelevant
  context rate;
- warm and one-file-change SCIP indexing;
- peak RSS of the external SCIP child process.

Additional fixtures must expand the oracle before any Joern/CPG adoption or
FLOW-001 precision claim. Conditions, callbacks, exceptions, async transitions,
HTTP registration, events, terminal effects, overloads, and unresolved dynamic
behavior still need independently reviewed cases.

## Adding a fixture

Create a directory under `packages/engine/fixtures/eval` containing its source,
build metadata, and a strict schema-version-1 `oracle.json`. Define the selected
symbols, resolved references, harmless one-file-change probe, per-provider
thresholds, and SCIP test files. The command discovers it automatically. CI
fails when a threshold or official SCIP assertion regresses.

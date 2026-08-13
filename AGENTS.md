# AGENTS.md — agent context for SDLC

SDLC is a local code-intelligence engine, a desktop app that installs and
supervises it, and thin companion plugins for coding harnesses.

Read this before changing the repository. It owns the product rails and routes
each task to its canonical documentation; it is deliberately not a second
reference manual.

> Product overview → [`README.md`](README.md) · Documentation map and ownership
> rules → [`docs/README.md`](docs/README.md) · Rules this codebase was burned by
> → [`CONVENTIONS.md`](CONVENTIONS.md)

## Read before significant work

1. [`CONVENTIONS.md`](CONVENTIONS.md) — gates code changes, where the rest gate product changes
2. [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md)
3. [`docs/CURRENT_STATE_AUDIT.md`](docs/CURRENT_STATE_AUDIT.md)
4. [`docs/BACKLOG.md`](docs/BACKLOG.md)
5. [`docs/PROVIDER_STRATEGY.md`](docs/PROVIDER_STRATEGY.md)
6. [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md) when evaluating an architectural dependency or approach

Everything else is indexed in [`docs/README.md`](docs/README.md).

## Product rails

**The stable product boundary.** SDLC is a standalone, local-first
code-intelligence application and knowledge engine. The desktop app is a
first-class product; Claude and Codex plugins, skills, and MCP connections are
thin clients. Keep deterministic facts, inferred relations, runtime
observations, human knowledge, and LLM-derived interpretations distinguishable
and evidence-backed.

**Flow is a prototype, not the vision.** The current flow implementation is a
useful call-graph prototype, not yet the entry-to-terminal-effect control/data-flow
model described in the vision. Preserve that distinction in product claims and
implementation decisions.

**Do not build language tooling before evaluating providers.** Do not implement
a production language resolver, compiler-reference indexer, or universal
control/data-flow engine before evaluating maintained SCIP, compiler/language-server,
or Code Property Graph providers. SDLC owns provider orchestration and
evidence-backed knowledge fusion, not solved language-tooling internals.

**Prefer adoption over invention.** Before building a substantial subsystem,
actively look for mature, battle-tested software that meets the need. If it is
technically strong, maintainable, securely packageable, and license-compatible,
integrate it instead of rolling an SDLC-specific replacement. Record the
evaluation when declining an obvious existing option, as a dated record in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

**Rust first for engine work.** Prefer Rust for new app-owned engine, indexing,
storage, orchestration, and background-runtime code. Use TypeScript when the
platform boundary makes it the sensible choice, such as Electron UI work, thin
JavaScript-tool integrations, or an ecosystem SDK with no practical Rust path.
Do not port working code solely to satisfy a language preference; apply this
rule to new work and measured rewrites.

## Engineering rules

Every rule this codebase has been burned by lives in
[`CONVENTIONS.md`](CONVENTIONS.md), and most are also in the store, so they
surface through `context` and `brief` without anyone opening a file. Two are
repeated here because getting them wrong is silent:

- **A tool that could not run is a gap, not a pass.** `skipped` and `failed` are
  distinct from `ok`, and neither may be presented as a clean result.
- **Where nothing resolved a symbol, say "uses not tracked", never "unused".**
  Reporting unknown as zero is how someone deletes live code.

## Build, test and run

```bash
npm run build && npm test -w @sdlc/engine
cargo test --manifest-path packages/scan-core/Cargo.toml
cargo clippy --manifest-path packages/scan-core/Cargo.toml --all-targets -- -D warnings
node scripts/smoke.mjs                    # end to end through the bridge
node scripts/check-docs.mjs               # documentation structure gate
```

Root `npm test` runs the engine suite only. It *builds* the Rust core through
the engine's `pretest`, but it never runs `cargo test` or `clippy`, so those
lines are not optional. And read the *warnings*, not only the errors: a
fix that was a dead store shipped from here because the build output was
filtered for `error`.

These now run on every platform in CI rather than Linux alone, which is how a
path-confinement rule that only worked on Unix was found.

A schema change additionally needs a run against an **existing** store, not
just a fresh one. That is the case `CREATE TABLE IF NOT EXISTS` hides.

## Repository map

This is a responsibility map, not a duplicated API reference.

| Area | Primary paths | Canonical doc |
|---|---|---|
| Native walk, parse, ignore policy, hashing, SQLite ownership | `packages/scan-core/` | [`packages/scan-core/README.md`](packages/scan-core/README.md) |
| Daemon, indexing, graph, analysis, MCP surface, eval harness | `packages/engine/src/` | [`packages/engine/README.md`](packages/engine/README.md) |
| **Runtime prompt assets — do not move** | `packages/engine/content/` (loaded by `src/content.ts`) | [`packages/engine/README.md`](packages/engine/README.md) |
| The stdio shim every harness spawns | `packages/mcp-bridge/` | [`packages/mcp-bridge/README.md`](packages/mcp-bridge/README.md) |
| Shared types and daemon discovery | `packages/protocol/` | [`docs/reference/state-and-config.md`](docs/reference/state-and-config.md) |
| Electron shell, supervision, CLI detection, packaging | `apps/desktop/` | [`apps/desktop/README.md`](apps/desktop/README.md) |
| Shipped Claude Code prompt assets | `plugins/sdlc/commands/` | [`docs/reference/plugin-commands.md`](docs/reference/plugin-commands.md) |
| CI, smoke, plugin validation, docs gate | `.github/workflows/ci.yml`, `scripts/` | [`CONVENTIONS.md`](CONVENTIONS.md) |

## Where to start, by task

| Task | Read first |
|---|---|
| Understand the product boundary or propose new scope | [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md) |
| Find out what actually works today | [`docs/CURRENT_STATE_AUDIT.md`](docs/CURRENT_STATE_AUDIT.md) |
| Pick up unfinished work | [`docs/BACKLOG.md`](docs/BACKLOG.md) |
| See what shipped, and when | [`docs/CHANGELOG.md`](docs/CHANGELOG.md) |
| Understand why a choice was made | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| Understand what the engine gives an agent | [`docs/ENGINE_DESIGN.md`](docs/ENGINE_DESIGN.md) |
| Add or change an MCP tool | [`docs/reference/mcp-tools.md`](docs/reference/mcp-tools.md), `CONVENTIONS.md` §Say what did not happen |
| Change the daemon HTTP API or discovery | [`docs/reference/http-api.md`](docs/reference/http-api.md) |
| Add or change a plugin command | [`docs/reference/plugin-commands.md`](docs/reference/plugin-commands.md) |
| Change the store, a schema, or a migration | `CONVENTIONS.md` §Schema changes need a migration |
| Change a fact, edge, or provenance field | [`docs/FACT_MODEL.md`](docs/FACT_MODEL.md) |
| Integrate or evaluate a code-intelligence provider | [`docs/PROVIDER_STRATEGY.md`](docs/PROVIDER_STRATEGY.md), [`docs/EVALUATION.md`](docs/EVALUATION.md) |
| Add an eval fixture or move a threshold | [`docs/EVALUATION.md`](docs/EVALUATION.md) |
| Change scanning, ignore policy, or parsing | [`packages/scan-core/README.md`](packages/scan-core/README.md) |
| Change packaging, install, or harness connection | [`apps/desktop/README.md`](apps/desktop/README.md), [`docs/reference/state-and-config.md`](docs/reference/state-and-config.md) |
| Evaluate an external dependency before building | [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md), §Prefer adoption over invention above |
| Work out where a new document goes | [`docs/README.md`](docs/README.md) |

## Documentation ownership

Each fact has one canonical home, registered in
[`docs/README.md`](docs/README.md). Elsewhere: a one-line summary and a link,
never a second copy.

- Current behaviour of a surface we expose → `docs/reference/`
- How and why the engine works the way it does → `docs/ENGINE_DESIGN.md`, `docs/FACT_MODEL.md`, `docs/PROVIDER_STRATEGY.md`
- What the implementation does today, and how mature it is → `docs/CURRENT_STATE_AUDIT.md`
- Unfinished work and its acceptance criteria → `docs/BACKLOG.md`
- A shipped outcome, dated → `docs/CHANGELOG.md`
- Why an approach was chosen or declined → `docs/DECISIONS.md`, **and** a `remember` in the store
- A rule this codebase was burned by → `CONVENTIONS.md`, **and** a `remember` in the store
- Measurements and thresholds → `docs/EVALUATION.md`; scan-core benchmarks → `packages/scan-core/README.md`
- Versions, pins, and packaging config → `package.json`, `Cargo.toml`, `electron-builder.yml` only, never prose

Hard rules:

- **An item leaves `docs/BACKLOG.md` when all its acceptance criteria are met.**
  Until then it stays, listing only unmet criteria. Every met criterion moves to
  `docs/CHANGELOG.md` as a dated outcome in the same change.
- **Do not add a document without linking it from a hub.** `CONVENTIONS.md` was
  orphaned from the day it was written; that is the failure this rule prevents.
- **If a path or heading moves, repoint every inbound link in the same change** —
  including code comments: `rg 'old-name' -g '*.md' -g '*.ts' -g '*.rs'`.
- **The store is primary for rules and decisions; the file is the readable
  summary.** Update both.
- `node scripts/check-docs.mjs` enforces the mechanical half of this.

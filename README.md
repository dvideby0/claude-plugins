# SDLC

A local code-intelligence engine, a desktop app that installs and supervises
it, and thin companion plugins for coding harnesses.

The durable product direction, implementation audit, prior-art research, and
prioritized backlog are indexed in [`docs/README.md`](docs/README.md).

> **Working on the code, including with an AI agent?** Start at
> [`AGENTS.md`](AGENTS.md) for the product rails, the build and test commands,
> and the task-to-document router.

## Why it is shaped this way

Coding harnesses spawn MCP servers **once per session**. Put the interesting
work inside one and you get a cold start every session, one copy of the index
per concurrent session, no work between sessions, and every dependency vendored
as a committed binary — this repository was carrying 4.2 MB of wasm for exactly
that reason.

So the work moved out into a long-lived local engine, and what the harness
spawns is a bridge that forwards to it.

```
┌─────────────────────┐        ┌──────────────────┐       ┌─────────────────┐
│  Desktop app        │ spawns │  Engine (daemon) │  MCP  │  Claude Code    │
│  (Electron)         │───────▶│  127.0.0.1:7420  │◀──────│  Codex          │
│                     │        │                  │ HTTP  │                 │
│  · supervises       │  HTTP  │  · scan, graph   │       │  · bridge (stdio)│
│  · detects CLIs     │◀──────▶│  · findings store│       │  · plugin skills │
│  · connects them    │   UI   │  · one per machine│      │                 │
└─────────────────────┘        └──────────────────┘       └─────────────────┘
```

The app's window loads the engine's own UI over HTTP, so there is one interface
rather than a desktop one and a web one that drift apart. An engine already
running in a terminal is adopted, not duplicated.

This is the product form of the picture. The engineering rendering, with links
into the source, is
[`docs/CURRENT_STATE_AUDIT.md`](docs/CURRENT_STATE_AUDIT.md#runtime-shape) —
change both together.

## Layout

| Path | What it is |
|---|---|
| [`packages/engine`](packages/engine/README.md) | The daemon: indexers, the store, analysis, and the MCP surface |
| [`packages/scan-core`](packages/scan-core/README.md) | Rust: parallel walking and native tree-sitter parsing |
| [`packages/mcp-bridge`](packages/mcp-bridge/README.md) | Thin stdio→daemon shim. All a harness ever spawns |
| `packages/protocol` | Shared types and daemon discovery, used by all three |
| [`apps/desktop`](apps/desktop/README.md) | Electron shell: supervision, CLI detection, window |
| [`plugins/sdlc`](plugins/sdlc/README.md) | Prompts only — understand, plan, audit |

## The scan core

Walking and parsing were 95% of scan time and ran on one core. They now run in
Rust on all of them — the `ignore` crate for the walk, native tree-sitter with
rayon for parsing.

The bundled Rust module is the single production source inventory and syntax
engine. Startup fails with an actionable error if the platform binary is
missing, rather than silently falling back to a weaker implementation with
different reference coverage.

Measurements and the crate's own rules are in
[`packages/scan-core/README.md`](packages/scan-core/README.md).

## Running it

```bash
npm install && npm run build
```

Start the app, which starts the engine:

```bash
npm run desktop
```

After indexing a TypeScript/JavaScript project, open **Flow** and select an
entry-to-outcome step. The side inspector shows the exact indexed source range,
its evidence status, and a route to the full file or resolved target definition.
The same bounded source surface is used by call-graph nodes, symbols, findings,
and file-backed search results. Each historical range is checked against the
source revision that produced it, not merely the latest inventory row. If the
working file no longer matches that revision, the app labels the evidence stale
rather than presenting the old range as current. Evidence created before
revision tracking, or by a live external tool without an attested source
snapshot, is labeled unverified.

In the desktop app, **Settings** shows the available code-intelligence
providers. After indexing a TypeScript/JavaScript project, its **Overview**
offers **Evaluate SCIP**, which compares the current prototype's coverage
against the bundled official SCIP indexer. That comparison is an evaluation
signal rather than a precision score, and its results are labelled partial and
unverified rather than promoted as exact. What that means, and what is still
unfenced, is in [Code-intelligence evaluation](docs/EVALUATION.md).

The checked-in provider corpus is separate from the desktop's live comparison.
It reports targeted precision/recall and performance for every current provider
and records unsupported measurements explicitly:

```bash
npm run --silent eval -- --json
```

See [Code-intelligence evaluation](docs/EVALUATION.md) for the oracle boundary,
official SCIP golden tests, current thresholds, and remaining coverage gaps.

Or run the engine on its own, headless:

```bash
npm run daemon
```

Then check the whole chain end to end — this spawns the bridge exactly the way
a harness does:

```bash
node scripts/smoke.mjs
```

## Connecting a harness

Open the app, go to **Settings**, and click **Connect**. It writes into
`~/.claude.json` (via `claude mcp add`) or `~/.codex/config.toml`, backing the
latter up first. Restart the harness afterwards.

What gets written is a launcher at `~/.sdlc/bin/sdlc-bridge`, which the daemon
regenerates on every startup to point at the current install. Harness config is
written once and read for months, so pointing it straight at a script inside
`node_modules` would break on the next upgrade — silently, because a missing
MCP server just means the tools quietly stop appearing.

The launcher runs the stdio bridge rather than an HTTP URL, because the bridge
reads the daemon's port at spawn time — a restart on a different port cannot
leave stale config behind either.

## Packaging

```bash
npm run package -w @sdlc/desktop
```

`apps/desktop/electron-builder.yml` produces a dmg, NSIS installer or AppImage,
bundling the engine, its content and the prebuilt native core, so installing
the app is enough to make the plugin work.

Native cores for all five targets are built per platform in CI
(`.github/workflows/ci.yml`). The engine treats the matching prebuilt core as a
required runtime dependency, and packaging validates that the correct binary
is present before signing.

## State

Everything the engine owns lives in `~/.sdlc/`:

| File | Contents |
|---|---|
| `daemon.json` | Port and bearer token of the running engine (mode 0600) |
| `workspaces.json` | Repositories the engine has been asked to index |
| `daemon.log` | What the engine did |
| `stores/<workspace-id>/audit.db` | Native SQLite code-intelligence store |
| `stores/<workspace-id>/backups/pre-v<version>-<timestamp>.db` | Latest standalone recovery image retained for each target schema version |

On first open, an older repository-local `sdlc-audit/audit.db` is copied into
app-owned storage and retained in place as a recoverable legacy backup. New
stores and all subsequent writes stay outside the source repository.

The full layout, discovery contract and environment variables are in
[State and configuration](docs/reference/state-and-config.md); the migration
and backup rules are in
[`CONVENTIONS.md`](CONVENTIONS.md#schema-changes-need-a-migration).

## Security

The engine binds to loopback only. Every request is checked for a loopback
`Host` (which defeats DNS rebinding) and a same-origin `Origin`; the API and
the MCP endpoint additionally require the bearer token. The UI shell is exempt
from the token because it is what delivers the token to the page.

## What the engine gives an agent

The store is memory, not a report. An audit is one thing that writes to it;
everything else reads from it while work is happening.

| Capability | Tools | Explained in |
|---|---|---|
| Get context before changing code | `brief`, `context`, `references`, `impact` | [Symbol-level references](docs/ENGINE_DESIGN.md#symbol-level-references) |
| Follow what actually runs | `flow`, `trace`, `search_code` | [Flow, not just clusters](docs/ENGINE_DESIGN.md#flow-not-just-clusters) · [Search by shape](docs/ENGINE_DESIGN.md#search-by-shape) |
| Author and maintain the human map | `map`, `map_drift`, `describe_component`, `gaps` | [Two maps](docs/ENGINE_DESIGN.md#two-maps) · [What the map cannot see](docs/ENGINE_DESIGN.md#what-the-map-cannot-see) |
| Keep knowledge across sessions | `remember`, `recall`, `relate`, `explored` | [What the map cannot see](docs/ENGINE_DESIGN.md#what-the-map-cannot-see) |
| Audit a repository | the `audit_*` family | [plugins/sdlc/docs/STRATEGY.md](plugins/sdlc/docs/STRATEGY.md) |

A memory carries the content hash of the file it was written against, so a note
about code that has since changed is flagged rather than trusted.

Every tool is catalogued in [MCP tools](docs/reference/mcp-tools.md). Why each
capability exists, and what it cannot see, is in
[Engine design](docs/ENGINE_DESIGN.md).

## Plugins

```
/plugin marketplace add dvideby0/claude-plugins
/plugin install sdlc
```

Every command is catalogued in
[Plugin commands](docs/reference/plugin-commands.md).

The design borrows from [superpowers](https://github.com/obra/superpowers),
[mattpocock/skills](https://github.com/mattpocock/skills) and
[ECC](https://github.com/affaan-m/ECC) — structured workflow, subagent
delegation, knowledge that survives the session. Where those persist to
markdown (`CONTEXT.md`, `.ecc/memory/`, session summaries), these persist to the
store, anchored to the code, with staleness detection. A note about code that
has since changed comes back flagged instead of quietly believed.

And subagents are briefed by a task-first, byte-budgeted query rather than a
file dump. The response says what was omitted and which evidence is stale, so
the orchestrator can keep its context small without treating silence as proof.

Plugins are prompts only. They carry no server and no binaries — the engine
provides the tools, so the skills stay small and the grounding stays shared.
Setup is in [`plugins/sdlc/README.md`](plugins/sdlc/README.md).

## Documentation

| Where | What it answers |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Working on this repository: product rails, build and test commands, and which document a task starts from |
| [`CONVENTIONS.md`](CONVENTIONS.md) | The rules this codebase has been burned by |
| [`docs/README.md`](docs/README.md) | Everything else — product direction, architecture, decisions, and where a new document goes |
| [`docs/reference/README.md`](docs/reference/README.md) | The surfaces we expose: MCP tools, the HTTP API, plugin commands, on-disk state |

## License

MIT

# SDLC

A local code-intelligence engine, a desktop app that installs and supervises
it, and thin companion plugins for coding harnesses.

The durable product direction, implementation audit, prior-art research, and
prioritized backlog are indexed in [`docs/README.md`](docs/README.md).

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

## Layout

| Path | What it is |
|---|---|
| `packages/engine` | The daemon: indexers, the store, analysis, and the MCP surface |
| `packages/scan-core` | Rust: parallel walking and native tree-sitter parsing |
| `packages/mcp-bridge` | Thin stdio→daemon shim. All a harness ever spawns |
| `packages/protocol` | Shared types and daemon discovery, used by all three |
| `apps/desktop` | Electron shell: supervision, CLI detection, window |
| `plugins/sdlc` | Prompts only — understand, plan, audit |

## The scan core

Walking and parsing were 95% of scan time and ran on one core. They now run in
Rust on all of them — the `ignore` crate for the walk, native tree-sitter with
rayon for parsing.

Migration measurement on a 10,557-file repository, 24.7 MB of source, M4 Max:

| Phase | Retired TS prototype | Rust | |
|---|---|---|---|
| walk | 1557 ms | 165 ms | 9.4× |
| parse | 3154 ms | 179 ms | 17.6× |
| **total** | **4711 ms** | **383 ms** | **12.3×** |

That comparison was the migration gate from the original TypeScript prototype.
The duplicate walker and parser are now retired: the bundled Rust module is the
single production source inventory and syntax engine. Startup fails with an
actionable error if the platform binary is missing instead of silently using a
weaker implementation with different reference coverage.

## Running it

```bash
npm install && npm run build
```

Start the app, which starts the engine:

```bash
npm run desktop
```

In the desktop app, **Settings** now shows the available code-intelligence
providers. Add and index a TypeScript/JavaScript project, open its **Overview**,
and choose **Evaluate SCIP** to compare the current prototype's document,
symbol, and reference coverage with the bundled official SCIP indexer. The
comparison is an evaluation signal, not a precision score. The Rust core
copies the indexed source generation into an app-owned input view and records
an attested manifest before SCIP runs; the result is marked stale after the
source index changes. Installed dependencies and other compiler inputs outside
that source view are not yet fenced or manifested, so results remain explicitly
partial and unverified rather than being promoted as exact. They do not replace
the project's trusted facts. Repositories without a TypeScript config are
evaluated through an app-owned inferred config; evaluation never creates a
`tsconfig.json` in the source repository. If the upstream indexer skips one of
several project configs, the usable comparison is retained and labeled
**partial** instead of being presented as a complete success. JavaScript
projects using `jsconfig.json` are discovered as well; invalid configs and
oversized files are reported rather than silently broadening or completing the
evaluation. Solution-style roots remain supported, with SCIP—not SDLC—resolving
their referenced project configs under the provider's process bounds.

Tree-sitter remains available if SCIP fails. Joern is shown only when its
`joern-parse` command is installed; detection does not yet enable or bundle the
planned control/data-flow adapter.

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
Schema compatibility, integrity checks, migration transactions, and online
backups are owned by the Rust SQLite runtime. A newer store is rejected without
changing its journal mode, and a failed migration rolls back while retaining
its pre-migration image. Retrying the same target version replaces its older
recovery image only after the new snapshot is complete and validated.

## Security

The engine binds to loopback only. Every request is checked for a loopback
`Host` (which defeats DNS rebinding) and a same-origin `Origin`; the API and
the MCP endpoint additionally require the bearer token. The UI shell is exempt
from the token because it is what delivers the token to the page.

## What the engine gives an agent

The store is memory, not a report. An audit is one thing that writes to it;
everything else reads from it while work is happening.

| Tool | For |
|---|---|
| `brief` | A short, ordered briefing ready to hand a subagent — constraints, surface, blast radius, covering tests. Use instead of dumping files into its prompt |
| `flow` | Entry points and what runs from each, layered by call depth. Shared utilities separated out |
| `trace` | Follow a call chain — what a symbol calls, transitively, or what reaches it |
| `search_code` | Match by code shape, not text: empty catch blocks, bare excepts, throws |
| `map` / `map_drift` | The system as someone would draw it, and which parts of that drawing the code has moved out from under |
| `describe_component` / `describe_flow` / `tag` | Author that drawing: named regions, ordered flows, cross-cutting labels |
| `gaps` | What the index cannot explain, ranked — the worklist for making the map real |
| `relate` / `relations` | Edges an agent worked out by reading, each with the line of code that proves it |
| `explored` | Mark a file examined, so the loop does not revisit the same ground |
| `context` | Everything known about a file or symbol before changing it: shape, importers, findings, and what earlier sessions recorded |
| `references` | Every place a symbol is used, with file and line — not just which files import its module |
| `impact` | What re-checking a change needs: which exports are actually used, by whom, and which tests already cover them |
| `resolve_types` | Prototype: upgrade references using the TypeScript checker |
| `remember` / `recall` / `forget` | Decisions, conventions, constraints and traps — anchored to the files they apply to |
| `cross_search` | The same questions across every indexed repository at once |
| `audit_query` | The resolved graph: definitions, importers, hotspots, cycles, packages |
| `audit_scan` / `audit_run_tools` / `audit_plan` | Index, deterministic analysis, risk ranking |
| `audit_review` | Model review run by the engine, with a verification pass |
| `audit_report` | The write-up, map and task list — returned, never written to disk |

A memory carries the content hash of the file it was written against, so a note
about code that has since changed is flagged rather than trusted.

### Symbol-level references

`edges` records which files import which. `refs` records which *lines* use which
*symbol*, so `impact` can say that a file with 6 importers exposes one export
used 12 times and another used never.

Two passes, because precision and speed want different tools.

The **fast pass** runs in Rust during every scan and resolves imported names: a
name imported from a module and used in the body resolves to that module's
definition. It covers exported functions, classes and constants, and costs
nothing on top of parsing.

The prototype **typed pass** (`resolve_types`) runs the TypeScript type checker and
resolves what the first cannot — `db.run(...)`, where the method belongs to an
inferred type and nothing was imported by that name, plus type positions. On
this repository it lifts `flush` from 0 references to 11 and `Db` from 0 to 61.
It is a full type-check, so it runs after indexing rather than during it; a
daemon can afford that, a server spawned per session cannot.

This direct compiler integration is useful prototype capability, not the
production semantic-indexing architecture. Future precise navigation follows
the [provider strategy](docs/PROVIDER_STRATEGY.md): evaluate and import a
maintained SCIP or compiler provider tied to a verified source snapshot, retain
Tree-sitter as the resilient fallback, and avoid expanding SDLC's own language
resolver. Today the prototype is TypeScript and JavaScript only — Python stays
import-resolved.

Where nothing resolves a symbol, the tools say **"uses not tracked"** rather
than "unused". Reporting unknown as zero is how someone deletes live code.

### Flow, not just clusters

A force-directed graph answers "what is near what". It has no direction, so it
cannot answer "where does a request start and where does it end up".

`flow` lays the call graph out in layers from its entry points — the callable
symbols nothing else calls, which in practice are route handlers, CLI commands
and exported API. Depth is the longest path from an entry, so a function always
appears to the right of everything that reaches it.

Shared utilities are what ruin these diagrams: a logger called from forty
places drags edges across every column. Anything called from six or more
distinct symbols is pulled into a commons lane and its edges are dashed.

In the app it is the **Flow** tab — entry points on the left, the graph beside
them, zoom and pan, and double-click to re-root on any node.

### Search by shape

`search_code` runs a tree-sitter query across the repository in Rust. A regex
finds the word `catch` and cannot tell an empty handler from a careful one; a
structural match can, because it matches the parse tree.

Named patterns cover the common questions (`swallowed-errors`, `throws`,
`python-bare-except`, `any-annotations`, …); a raw tree-sitter query covers
everything else. A `text` filter applies after the structural match, since
shape and content together are usually what the question needs.

### Two maps

The scan produces the machine's map: files, symbols, edges. It is correct and
nearly unreadable, because nobody explains a system by listing its imports.

The second map is the one a person draws — a handful of named boxes, arrows
with verbs on them, notes about what matters. It is authored rather than
derived: an agent reads the code and records the interpretation, and the
machine map stays underneath as evidence, so any box can be expanded back into
the files it claims.

| | Machine map | Drawn map |
|---|---|---|
| Made by | the scanner | an agent that read the code |
| Holds | files, symbols, refs, edges | components, flows, tags |
| Answers | "what imports this" | "what happens when a request arrives" |
| Trusted because | it was parsed | it cites the code, and says when that code moved |

Coverage is the honest part: files in no component are the parts nobody has
explained yet.

### One button

In the app, **Build the map** runs both passes: the deterministic scan, then
your own coding CLI, spawned in the repository, told to read the code and draw
the map over it. Progress shows the tools the agent is calling as it calls
them, and the map appears when it finishes. **Scan only** stops after the index.

It drives the CLI you already have rather than calling a model directly, so the
drawing runs under your auth, your model choice and your MCP config, and it
reaches the engine through the same tools an interactive session uses. It is
given read-only file access and the engine's tools — nothing that edits the
repository.

### Crossing between them

Every box opens onto the files underneath it: paths, line counts, symbols and
how depended-on each one is, ordered by that. Any file opens further into its
importers, imports and symbols — and says which box it belongs to, so the route
runs both ways. Flow steps open the file they name.

### The first draw is expensive; changes are not

Every box records a per-file snapshot of what it contained when it was drawn.
`map_drift` diffs that against the index and names the components whose files
edited, the files themselves, and the flows whose steps moved — so a change
means re-reading two files, not redrawing a repository.

```
map_drift  →  redraw only what it names  →  the rest still stands
```

`/map` drives both passes and knows which one it is on.

### What the map cannot see

A scan produces a map of what exists. It is silent about meaning — and worse,
silent about its own silence: a call graph with a hole in it looks exactly like
a call graph with nothing there.

Found on a real repository. A LangGraph project wires its entire control flow
with `graph.add_node("classify", classify_node)`. There is no static call from
the wiring to the node, so every node function looked like an unreachable entry
point and the flow view showed type inheritance where the workflow should have
been. The parse was correct; it simply could not know.

So the scan's job becomes finding where understanding is missing:

```
gaps  →  an agent reads the file  →  relate(evidence)  →  explored
```

`gaps` ranks what could not be resolved — files that register behaviour rather
than calling it, exported symbols nothing reaches, imports that resolved to
nothing, heavily-used files with nothing recorded about them, notes written
against code that has since changed. `coverage` reports how much of the
repository has been read since it last changed.

Recorded edges live in their own table, never merged into parsed ones: a
parsed fact and an asserted one should never be indistinguishable. **Evidence
is required** — a relation carries the line of code that justifies it and the
hash of the file it was read from, so a claim can be audited and one about
changed code is flagged rather than believed.

`/enrich` drives the loop, one subagent per gap.

### Watch

The daemon watches every registered repository and re-scans what changed, with
a 1.5s debounce so a branch switch or a formatter run costs one pass. Watched
changes trigger a scan only — re-running the project's linters on every save
would be intolerable, so the analyser pass stays explicit. `SDLC_WATCH=0`
disables it, as does the toggle on `/api/watch`.

## Plugins

```
/plugin marketplace add dvideby0/claude-plugins
/plugin install sdlc
```

| Command | Does |
|---|---|
| `/understand <thing>` | Explains how something works, grounded in the index and prior memories — then records what it worked out |
| `/grill <area>` | Interviews you until the domain model is clear, then anchors it to the code instead of a glossary file |
| `/brainstorm <idea>` | Loads what was already decided before proposing, so settled questions are not reopened |
| `/plan <change>` | Plans against the real structure: where it goes, its blast radius, what constrains it |
| `/implement <change>` | Subagent per task, each briefed by `brief` rather than by reading the repo; verified against `impact` |
| `/debug <symptom>` | Follows references to the cause instead of guessing, then records it as a gotcha |
| `/handoff` | Persists the durable part of a session to the store; keeps the situational part out of it |
| `/audit` | Full pass: index, tools, risk ranking, sub-agent review |
| `/audit-quick`, `/audit-security` | Deterministic only; security lens |

The design borrows from [superpowers](https://github.com/obra/superpowers),
[mattpocock/skills](https://github.com/mattpocock/skills) and
[ECC](https://github.com/affaan-m/ECC) — structured workflow, subagent
delegation, knowledge that survives the session. Where those persist to
markdown (`CONTEXT.md`, `.ecc/memory/`, session summaries), these persist to the
store, anchored to the code, with staleness detection. A note about code that
has since changed comes back flagged instead of quietly believed.

And subagents are briefed by query rather than by file dump, which is what
keeps the orchestrator's context small enough to run the whole job.

Plugins are prompts only. They carry no server and no binaries — the engine
provides the tools, so the skills stay small and the grounding stays shared.

## License

MIT

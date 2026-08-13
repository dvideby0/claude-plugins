# State and configuration

> [Reference](README.md) · [Documentation hub](../README.md)

Everything the engine owns on disk, how the three processes find each other,
and the environment variables that move any of it.

The shared paths — the state directory itself and everything directly inside it
— are defined once, in `packages/protocol/src/paths.ts`, because the engine
writes them and the bridge and desktop app read them. Three entries below are
built elsewhere and are marked as such.

## The state directory

Everything lives under `~/.sdlc/`, or `$SDLC_HOME` when set.

| Path | Contents |
|---|---|
| `daemon.json` | Port and bearer token of the running engine. Mode 0600, removed on clean shutdown |
| `daemon.lock` | Atomic cross-process ownership marker, held for the daemon's lifetime |
| `daemon.log` | What the engine did, when it is run headless |
| `workspaces.json` | The directories the user has allowed the engine to index |
| `stores/<workspace-id>/audit.db` | Native SQLite code-intelligence store, one per repository. Path built in `packages/engine/src/db/db.ts` |
| `stores/<workspace-id>/backups/pre-v<version>-<nonce>.db` | Newest validated standalone recovery image retained per target schema version. Written by `packages/scan-core/src/database.rs` |
| `providers/` | App-owned inputs, outputs and manifests produced by external analysis providers |
| `bin/sdlc-bridge` | Launcher a harness spawns, regenerated on every daemon startup. Built in `packages/engine/src/daemon/launcher.ts`; `sdlc-bridge.cmd` on Windows |

Nothing is written inside the source repository. On first open, an older
repository-local `sdlc-audit/audit.db` is copied into app-owned storage and
retained in place as a recoverable legacy backup.

Migration, rollback and backup policy is a rule rather than a description:
[`../../CONVENTIONS.md`](../../CONVENTIONS.md#schema-changes-need-a-migration).

## Discovery

There is one engine per machine. A process that wants it reads `daemon.json`
for the port and token; a daemon that finds a live lock adopts the running
engine rather than starting a second one.

The bridge resolves the port **at spawn time**, which is why harness config
points at `~/.sdlc/bin/sdlc-bridge` and not at an HTTP URL or a script inside
`node_modules`. Config is written once and read for months: a restart on a
different port, or an upgrade that moves the install, would otherwise break it
silently — a missing MCP server just means the tools quietly stop appearing.

## Environment

| Variable | Effect |
|---|---|
| `SDLC_HOME` | Move the whole state directory. For tests and portable installs |
| `SDLC_PORT` | Port the daemon prefers. Defaults to 7420 |
| `SDLC_WATCH` | `0` disables repository watching. The `/api/watch` toggle does the same at runtime |
| `SDLC_CONTENT_DIR` | Directory holding the engine's `lang/` and `lenses/` prompt assets. Set this when they are not beside the built engine |
| `SDLC_PROJECT_ROOT` | Repository the **bridge** reports as current, defaulting to its working directory. Read by `@sdlc/mcp-bridge`, not by the engine |
| `SDLC_BRIDGE_COMMAND`, `SDLC_BRIDGE_SCRIPT`, `SDLC_BRIDGE_ELECTRON` | Override what the generated launcher runs. Packaging sets these |

Versions and pins are not configuration: they are canonical in `package.json`,
`Cargo.toml` and `electron-builder.yml`.

---

The shared state paths are canonical in `packages/protocol/src/paths.ts`; the
three derived entries name their own source above. Documentation placement rules
live in the [documentation hub](../README.md).

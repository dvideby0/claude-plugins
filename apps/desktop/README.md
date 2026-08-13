# @sdlc/desktop

> [SDLC](../../README.md) · [Documentation hub](../../docs/README.md) · [Conventions](../../CONVENTIONS.md)

The desktop shell for the SDLC engine: it installs the engine, supervises it,
detects your coding CLIs, and connects them.

## What it owns

- **Supervision** — starting the engine, adopting one already running in a
  terminal rather than starting a second, and tailing `~/.sdlc/daemon.log`.
- **Harness detection and connection** — writing the MCP launcher into
  `~/.claude.json` or `~/.codex/config.toml`, backing the latter up first.
- **The window** — which loads the engine's own UI over HTTP, so there is one
  interface rather than a desktop one and a web one that drift apart.
- **Packaging** — `electron-builder.yml` is canonical for packaging config.

## Boundaries

- **electron-builder and npm workspaces do not mix unattended.** The traps, and
  the three config knobs that keep packaging working, are in
  [`CONVENTIONS.md`](../../CONVENTIONS.md#electron-builder-and-npm-workspaces-do-not-mix-unattended).
  Read that before changing anything about the build.
- **The engine runs as a plain Node child process**, not inside Electron's
  renderer or main context.
- **The matching prebuilt native core is a required runtime dependency.**
  Packaging validates the correct binary is present before signing; a missing one
  is a broken installation rather than a silent capability change.
- **This app renders the store, it does not own it.** Schema and migrations
  belong to [`@sdlc/scan-core`](../../packages/scan-core/README.md).

## Working on it

```bash
npm run desktop
npm run package -w @sdlc/desktop
```

CI builds native cores for all five targets per platform and runs
`package:dir` for each. The full verification sequence is in
[`AGENTS.md`](../../AGENTS.md#build-test-and-run).

---

On-disk state → [State and configuration](../../docs/reference/state-and-config.md).

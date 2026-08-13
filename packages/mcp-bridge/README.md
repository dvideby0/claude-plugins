# @sdlc/mcp-bridge

> [SDLC](../../README.md) · [Documentation hub](../../docs/README.md)

A thin stdio MCP server that forwards to the local SDLC engine. This is all a
coding harness ever spawns.

## What it owns

Nothing but the hop. It looks up the running daemon's port and token in
`~/.sdlc/daemon.json` and forwards MCP traffic over HTTP. No index, no store, no
analysis — those are the engine's, so they stay warm between sessions and shared
across harnesses.

It stays resident for the session rather than exiting after one call, and polls
so it can raise `tools/list_changed` when the engine's surface changes.

## Boundaries

- **The daemon is looked up per request, not once at startup.** A restart on a
  different port is therefore survivable mid-session, and harness config never
  needs to name a port or a URL.
- **The launcher is regenerated on every daemon startup**, so it always points at
  the current install. That is why harness config names
  `~/.sdlc/bin/sdlc-bridge` rather than a script inside `node_modules`: config is
  written once and read for months, so a path that moves on the next upgrade
  would break silently — a missing MCP server just means the tools quietly stop
  appearing.

## Working on it

```bash
npm run build -w @sdlc/mcp-bridge
node scripts/smoke.mjs    # spawns this bridge the way a harness does
```

---

Discovery contract → [State and configuration](../../docs/reference/state-and-config.md).

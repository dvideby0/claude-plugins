# @sdlc/mcp-bridge

> [SDLC](../../README.md) · [Documentation hub](../../docs/README.md)

A thin stdio MCP server that forwards to the local SDLC engine. This is all a
coding harness ever spawns.

## What it owns

Nothing but the hop. It reads the running daemon's port and token from
`~/.sdlc/daemon.json`, forwards MCP traffic to it over HTTP, and exits. No
index, no store, no analysis — those are the engine's, so they stay warm between
sessions and shared across harnesses.

## Boundaries

- **The port is resolved at spawn time, not at config time.** That is why
  harness config points at the `~/.sdlc/bin/sdlc-bridge` launcher rather than an
  HTTP URL: a daemon restart on a different port cannot leave stale config
  behind.
- **The launcher is regenerated on every daemon startup**, so it always points at
  the current install. Pointing harness config straight at a script inside
  `node_modules` would break on the next upgrade — silently, because a missing
  MCP server just means the tools quietly stop appearing.

## Working on it

```bash
npm run build -w @sdlc/mcp-bridge
node scripts/smoke.mjs    # spawns this bridge the way a harness does
```

---

Discovery contract → [State and configuration](../../docs/reference/state-and-config.md).

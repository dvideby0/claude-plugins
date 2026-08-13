# Reference

> [Documentation hub](../README.md) · [SDLC](../../README.md)

The surfaces SDLC exposes: what an agent, a harness, or the desktop actually
calls, and the state those calls read and write. Why the engine works this way
is [`ENGINE_DESIGN.md`](../ENGINE_DESIGN.md); this is what it offers.

## Surfaces

| Surface | Catalog | Implemented in |
|---|---|---|
| MCP tools | [`mcp-tools.md`](mcp-tools.md) | `packages/engine/src/mcp/server.ts` |
| Daemon HTTP API | [`http-api.md`](http-api.md) | `packages/engine/src/daemon/http.ts` |
| Plugin commands | [`plugin-commands.md`](plugin-commands.md) | `plugins/sdlc/commands/` |
| On-disk state and configuration | [`state-and-config.md`](state-and-config.md) | `packages/protocol/`, `packages/engine/src/daemon/` |

## Finding and maintaining the reference

- **Know the task?** Open the matching catalog above.
- **Know the tool or route name?** Search this directory for it.
- **Need to know why a capability exists?** [`ENGINE_DESIGN.md`](../ENGINE_DESIGN.md)
  owns the narrative; pages here own the surface.
- **Need a procedure rather than a contract?** Installing, connecting a harness
  and packaging live in [`../../README.md`](../../README.md).
- **Adding a tool, route or command?** Add its row to the matching catalog in the
  same change. A tool's one-line purpose is canonical in its own
  `server.tool(...)` description — a catalog row quotes it rather than inventing
  a second wording.
- **Adding a catalog?** Only when a genuinely new surface exists, not when an
  existing one grows.

`node scripts/check-docs.mjs` fails when a catalog and its source disagree, so
these tables cannot silently drift the way the README's copies did.

---

Documentation placement and single-source-of-truth rules live in the
[documentation hub](../README.md).

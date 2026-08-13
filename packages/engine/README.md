# @sdlc/engine

> [SDLC](../../README.md) · [Documentation hub](../../docs/README.md) · [Conventions](../../CONVENTIONS.md)

The long-lived local code-intelligence engine: it indexes repositories and
serves them over MCP. One per machine, adopted rather than duplicated when it is
already running.

## What it owns

| Path | What lives there |
|---|---|
| `src/daemon/` | The HTTP server, auth, watching, and the workspace registry |
| `src/mcp/` | The MCP surface. `server.ts` is canonical for the tool set |
| `src/scan/`, `src/graph/`, `src/facts/` | Indexing, the resolved graph, and the fact envelope |
| `src/analyze/`, `src/findings/`, `src/review/`, `src/plan/`, `src/report/` | The audit pipeline |
| `src/knowledge/`, `src/memory/` | Authored relations and memories |
| `src/eval/` | The measurement harness behind `npm run eval` |
| `src/db/` | Compatibility adapter only — SQLite ownership is Rust's |
| `ui/` | The engine's own UI, served over HTTP so there is one interface |
| `content/` | **Runtime data, not documentation** — see below |

## Boundaries

- **`content/` is runtime data.** `src/content.ts` loads `lang/`, `lenses/`,
  `prompts/` and `schemas/` by path, and packaging bundles them. Moving or
  renaming these files breaks startup. They are markdown because a model reads
  them, not because they are docs — do not index them from a documentation hub
  or edit them for tidiness. `SDLC_CONTENT_DIR` overrides the location.
- **`src/db/` does not own the database.** Schema, migrations, backups and FTS
  belong to [`@sdlc/scan-core`](../scan-core/README.md).
- **`src/graph/typed.ts` is a prototype**, kept as an evaluation baseline. Do not
  expand its project or package-resolution machinery before evaluating a
  maintained provider — [`PROVIDER_STRATEGY.md`](../../docs/PROVIDER_STRATEGY.md).
- **The event loop is the product.** Long native work goes through an async task;
  a synchronous native call blocks every connected harness at once.

## Working on it

```bash
npm run build -w @sdlc/engine && npm test -w @sdlc/engine
npm run --silent eval -- --json
npm run daemon
```

`prebuild` must clean this package's exact `dist` directory before compiling, or
retired runtime code stays in the packaged desktop after it disappears from
`src`. The full verification sequence is in
[`AGENTS.md`](../../AGENTS.md#build-test-and-run).

---

Tool contracts → [MCP tools](../../docs/reference/mcp-tools.md). Routes →
[HTTP API](../../docs/reference/http-api.md). Why the capabilities exist →
[Engine design](../../docs/ENGINE_DESIGN.md).

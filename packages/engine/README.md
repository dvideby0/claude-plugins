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
| `src/providers/` | SCIP orchestration: input views, manifests, and comparison |
| `src/analyze/`, `src/findings/`, `src/review/`, `src/plan/`, `src/report/` | The audit pipeline |
| `src/knowledge/`, `src/memory/` | Authored relations and memories |
| `src/eval/` | The measurement harness behind `npm run eval` |
| `src/db/` | Store paths, the legacy-store copy, permission hardening, and the connection cache. Not the schema |
| `src/lib/`, `src/content.ts`, `src/stdio.ts` | Shared helpers, content loading, and the stdio entry point |
| `ui/` | The engine's own UI, served over HTTP so there is one interface |
| `content/` | **Runtime data, not documentation** — see below |

## Boundaries

- **`content/` is runtime data.** `src/content.ts` reads files by caller-supplied
  relative path — no globbing — and packaging bundles the directory. `lang/` is
  loaded from `src/plan/rules.ts`, `lenses/` from `src/plan/context.ts`, and
  `prompts/` from `src/daemon/draw.ts`. Moving or renaming any of them breaks
  startup. The markdown is there because a model reads it, not because it is
  documentation — do not index it from a documentation hub or edit it for
  tidiness. `SDLC_CONTENT_DIR` overrides the location.
- **`src/db/` does not own the database.** Schema, migrations, backups and FTS
  belong to [`@sdlc/scan-core`](../scan-core/README.md). What lives here is the
  TypeScript side: where a workspace's store goes, the one-time copy of a legacy
  repository-local store, 0600/0700 hardening, and the serialized connection
  cache.
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

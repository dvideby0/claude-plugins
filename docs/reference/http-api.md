# Daemon HTTP API

> [Reference](README.md) · [Documentation hub](../README.md)

The engine serves one HTTP surface on loopback. The desktop shell, the MCP
endpoint and the UI all come through it, which is why there is one interface
rather than a desktop one and a web one that drift apart.

Implemented in `packages/engine/src/daemon/http.ts`. The port and bearer token
of a running engine are in `~/.sdlc/daemon.json` — see
[`state-and-config.md`](state-and-config.md) for discovery.

## Authentication

Three checks, in this order, before any handler runs:

1. **Loopback and same-origin.** Every request needs a loopback `Host`, which
   defeats DNS rebinding, and a same-origin `Origin`.
2. **Bearer token.** `/mcp` and everything under `/api/` require the token from
   `daemon.json`.
3. **UI bootstrap.** `/` and `/index.html` are exempt from the bearer token,
   because serving the shell is what delivers the token to the page. They
   require a one-time navigation credential instead.

A malformed URL is rejected with `400` before any of this. An unknown path
under `/api/` is `404`.

## Engine

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness and engine version. Answers any method |
| `GET /api/status` | Version, start time, pid, bound port, workspace count, and how many roots are being watched |
| `POST /api/shutdown` | Acknowledges with `202`, then lets the daemon own lock cleanup and termination |
| `GET /api/providers` | Which code-intelligence providers are detected on this machine |
| `GET \| POST /api/watch` | Read the watch state, or toggle it with `{ "enabled": boolean }`. Returns the state either way |
| `GET /api/search` | Cross-repository search. `q` is required; `kind` selects a facet and defaults to `all`. An unknown kind is `400` |

## Workspaces

| Route | Purpose |
|---|---|
| `GET /api/workspaces` | Every registered repository with its current status |
| `POST /api/workspaces` | Register a repository from `{ "root": path }`. `201` on success; a missing or non-directory root is `400` |
| `DELETE /api/workspaces/:id` | Deregister a repository, stopping any running index first |
| `POST /api/workspaces/:id/index` | Start an index run |
| `POST /api/workspaces/:id/stop` | Ask a running index to stop |
| `GET /api/workspaces/:id/:view` | Read one view of the store |

`:id` is a twelve-character hex workspace id. `:view` is one of `graph`,
`flow`, `execution-flow`, `map`, `component`, `findings`, `overview`, `file`,
`memories`, `report` or `review`.

## Providers and findings

| Route | Purpose |
|---|---|
| `GET /api/workspaces/:id/providers` | Provider capabilities for this repository |
| `POST /api/workspaces/:id/providers/scip-typescript/evaluate` | Run the bundled official SCIP indexer and compare coverage with the current prototype. An evaluation signal, not a precision score — see [`../EVALUATION.md`](../EVALUATION.md) |
| `POST /api/workspaces/:id/findings/:fingerprint/suppress` | Accept a finding or mark it a false positive. Suppressions persist across runs |

## Harnesses

| Route | Purpose |
|---|---|
| `GET /api/harnesses` | Which coding harnesses are installed and whether each is connected |
| `POST /api/harnesses/:harness/connect` | Write the MCP launcher into that harness's config |
| `POST /api/harnesses/:harness/disconnect` | Remove it again |

What connecting actually writes, and why it points at a regenerated launcher
rather than into `node_modules`, is in
[`../../README.md`](../../README.md#connecting-a-harness).

## MCP

`/mcp` carries the Model Context Protocol endpoint. The tools it exposes are
catalogued in [`mcp-tools.md`](mcp-tools.md). Harnesses do not call this
directly — they spawn the stdio bridge, which reads the port at spawn time.

---

Routes are canonical in `packages/engine/src/daemon/http.ts`. Documentation
placement rules live in the [documentation hub](../README.md).

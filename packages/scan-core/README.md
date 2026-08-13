# @sdlc/scan-core

> [SDLC](../../README.md) · [Documentation hub](../../docs/README.md) · [Conventions](../../CONVENTIONS.md)

Parallel repository walking and parsing for the SDLC engine, plus the SQLite
store that owns everything derived from them. The only Rust crate in the
repository, shipped as a napi `.node` binary.

## What it owns

- **The walk** — the `ignore` crate, one inclusion decision in `input_policy.rs`
  that both the scan and the watcher ask, and the recorded reason for every
  exclusion.
- **Parsing** — native tree-sitter in `parse.rs`, driven in parallel with rayon
  from `lib.rs`.
- **Freshness and identity** — `freshness.rs` and `signature.rs`: the filesystem
  identity key and the racy-clean rule. Content hashing happens during the walk,
  in `walk.rs`.
- **The store** — `database.rs` plus the immutable `database_schema_v*.sql`
  files: schema gating, ordered migrations, validated pre-migration backups,
  and the FTS5 access path.
- **Bounded adapters** — `git_changes.rs` (porcelain v2), `http_flow.rs` (route
  guards and response effects), `task_context.rs` (the `brief` planner),
  `provider.rs` (bounded SCIP ingestion, projected into facts).

## Boundaries

- **The binary is a required runtime dependency.** Startup fails with an
  actionable error when the platform binary is missing, rather than silently
  falling back to a weaker implementation with different reference coverage.
  There is no TypeScript walker or WASM parser to fall back to — both were
  retired.
- **Only the repository's own committed `.gitignore` decides what is source.**
  Not `.ignore`, not the global gitignore, not `$GIT_DIR/info/exclude`, not
  parent directories. Determinism across clones is the point —
  [`CONVENTIONS.md`](../../CONVENTIONS.md#only-the-repositorys-own-content-decides-what-is-source).
- **A schema file that has shipped is immutable.** New versions get a new file
  and an ordered migration case; see
  [`CONVENTIONS.md`](../../CONVENTIONS.md#schema-changes-need-a-migration).
  A schema change must be run against an *existing* store, not just a fresh one.
- **Writes are synchronous inside a transaction**, and long native work goes
  through an async task rather than blocking the daemon's event loop.

## Measurements

Migration measurement against the retired TypeScript prototype, on a
10,557-file repository, 24.7 MB of source, M4 Max:

| Phase | Retired TS prototype | Rust | |
|---|---|---|---|
| walk | 1557 ms | 165 ms | 9.4× |
| parse | 3154 ms | 179 ms | 17.6× |
| **total** | **4711 ms** | **383 ms** | **12.3×** |

That comparison was the migration gate. Incremental-walk measurements are in
[`CHANGELOG.md`](../../docs/CHANGELOG.md#2026-08-13); provider and retrieval
results are in [`EVALUATION.md`](../../docs/EVALUATION.md).

## Working on it

```bash
cargo test --manifest-path packages/scan-core/Cargo.toml
cargo clippy --manifest-path packages/scan-core/Cargo.toml --all-targets -- -D warnings
npm run build -w @sdlc/scan-core
```

Root `npm test` builds this crate but never runs `cargo test` or `clippy`.
The full verification sequence is in
[`AGENTS.md`](../../AGENTS.md#build-test-and-run).

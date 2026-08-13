# Documentation hub

> [SDLC](../README.md)

This is the map of everything written down about SDLC, and the rules that keep
it from drifting. Product direction, architecture, and the surfaces we expose
live here. Rules that gate a code change live in
[`../CONVENTIONS.md`](../CONVENTIONS.md); the agent entry point is
[`../AGENTS.md`](../AGENTS.md).

## Start here

| I am | Read |
|---|---|
| an agent about to change code | [`../AGENTS.md`](../AGENTS.md), then [`../CONVENTIONS.md`](../CONVENTIONS.md) |
| evaluating the product | [`../README.md`](../README.md) |
| looking for what to work on next | [`BACKLOG.md`](BACKLOG.md) |
| trying to place a new document | [§Adding or moving a document](#adding-or-moving-a-document) |

## How these docs are organized

Three levels, each giving just enough to decide whether to go deeper.

- **Entry points** — [`../AGENTS.md`](../AGENTS.md) owns the product rails and
  routes each task to one document. [`../CLAUDE.md`](../CLAUDE.md) points tools
  there and repeats only the load-bearing contract. Neither is a reference manual.
- **Gateways** — this hub, [`../README.md`](../README.md), and
  [`reference/README.md`](reference/README.md). Each answers its domain's top
  question and links deeper.
- **Topic pages** — everything below. Read when a task needs the detail.

One tree goes a level further: `plugins/sdlc/commands/` is already one record
per command, so [`reference/plugin-commands.md`](reference/plugin-commands.md)
is a catalog pointing at files that exist rather than a second copy of them.
Nothing else here is deep enough to earn that hop.

## Direction, history and decisions

- [Product vision](PRODUCT_VISION.md) — what we are building, why it is a standalone application, and the boundaries that should remain stable as the implementation changes.
- [Current-state audit](CURRENT_STATE_AUDIT.md) — how good the implementation is right now, per capability, with the highest-risk gaps. Replaced in place each audit.
- [Backlog](BACKLOG.md) — unfinished work only, with the acceptance criteria still unmet.
- [Changelog](CHANGELOG.md) — what shipped, dated.
- [Decisions](DECISIONS.md) — why an approach was chosen or declined, and what lost.

## How it works

- [Engine design](ENGINE_DESIGN.md) — what the engine gives an agent and why: symbol-level references, flow layering, the two maps, drift, gaps, and what the map cannot see.
- [Fact model](FACT_MODEL.md) — the provider-neutral fact, edge, and provenance contract every indexer writes through.
- [Provider strategy](PROVIDER_STRATEGY.md) — the decision to import proven syntax, semantic, and program-analysis facts instead of rebuilding language tooling.
- [Evaluation](EVALUATION.md) — the measurement harness: the oracle boundary, what is measured today, and how to add a fixture.
- [Prior art](PRIOR_ART.md) — systems worth learning from and the concrete lessons we should borrow or avoid.

## Reference

[`reference/README.md`](reference/README.md) — the surfaces we expose: MCP
tools, the daemon HTTP API, plugin commands, and the on-disk state and
configuration contract.

## Elsewhere in the repository

- [`../CONVENTIONS.md`](../CONVENTIONS.md) — the rules this codebase has been burned by, each tied to a real incident. It carries its own index.
- [`../plugins/sdlc/README.md`](../plugins/sdlc/README.md) — the companion Claude Code plugin.
- [`../plugins/sdlc/docs/STRATEGY.md`](../plugins/sdlc/docs/STRATEGY.md) — the plugin's analysis model.
- Per-workspace READMEs: [`scan-core`](../packages/scan-core/README.md), [`engine`](../packages/engine/README.md), [`mcp-bridge`](../packages/mcp-bridge/README.md), [`desktop`](../apps/desktop/README.md).

## Single source of truth

Each fact has exactly **one** canonical home. Everywhere else carries a one-line
summary plus a link — never a second copy. This is what keeps the docs from
drifting.

| Fact | Canonical home | Everywhere else |
|---|---|---|
| The MCP tool set and each tool's one-line purpose | `packages/engine/src/mcp/server.ts` | [`reference/mcp-tools.md`](reference/mcp-tools.md) quotes and routes; `../README.md` links, never lists. No doc restates a schema |
| Daemon HTTP routes and their auth posture | `packages/engine/src/daemon/http.ts` | [`reference/http-api.md`](reference/http-api.md) describes them; `../README.md` §Security summarizes the posture. Unlike the tool catalog, this one is **not** machine-checked |
| The plugin command set | each command file's frontmatter `description:` | [`reference/plugin-commands.md`](reference/plugin-commands.md) is the one catalog; both READMEs link to it |
| `~/.sdlc` layout, ports, token, `SDLC_HOME`, `SDLC_WATCH` | [`reference/state-and-config.md`](reference/state-and-config.md) | `../README.md` keeps the user-facing file table; the plugin README gives one sentence |
| Scan-core benchmark numbers | [`../packages/scan-core/README.md`](../packages/scan-core/README.md) | `../README.md` says walking and parsing are native and links. No numbers elsewhere |
| Store migration, rollback and backup policy | `../CONVENTIONS.md` §Schema changes need a migration | `../README.md` §State describes what a user sees; [`DECISIONS.md`](DECISIONS.md) records why rusqlite |
| Evaluation results, thresholds, oracle boundary | [`EVALUATION.md`](EVALUATION.md) | `../README.md` says how to run `npm run eval`. No scores in the README |
| Fact, edge and provenance envelope | [`FACT_MODEL.md`](FACT_MODEL.md) | [`CURRENT_STATE_AUDIT.md`](CURRENT_STATE_AUDIT.md) describes what is implemented against it |
| Provider policy — what SDLC will not build | [`PROVIDER_STRATEGY.md`](PROVIDER_STRATEGY.md) | `../AGENTS.md` carries the one-paragraph rail; `graph/typed.ts` cites it in a comment |
| Engine capability narrative | [`ENGINE_DESIGN.md`](ENGINE_DESIGN.md) | `../README.md` keeps a capability grouping and links |
| Current maturity assessment | [`CURRENT_STATE_AUDIT.md`](CURRENT_STATE_AUDIT.md) | Replaced in place per audit; dated outcomes go to [`CHANGELOG.md`](CHANGELOG.md) |
| Unfinished work and unmet acceptance criteria | [`BACKLOG.md`](BACKLOG.md) | Met criteria move to [`CHANGELOG.md`](CHANGELOG.md) in the same change |
| What shipped, and when | [`CHANGELOG.md`](CHANGELOG.md) | [`DECISIONS.md`](DECISIONS.md) carries the rationale; the audit carries the assessment; the backlog carries none |
| Why X over Y, and what lost | [`DECISIONS.md`](DECISIONS.md) and the store via `remember` | `../CONVENTIONS.md` states the rule that resulted, not the deliberation |
| Rules the codebase was burned by | [`../CONVENTIONS.md`](../CONVENTIONS.md) | The store holds the same rules as anchored memories |
| How to verify a change | `../AGENTS.md` §Build, test and run | Workspace READMEs carry only their own commands |
| Workspace responsibilities | `../AGENTS.md` §Repository map | Each workspace README expands its own row and nothing else |
| Dependency versions, schema version, packaging config | `package.json`, `Cargo.toml`, `DATABASE_SCHEMA_VERSION`, `electron-builder.yml` | Docs describe purpose, never pin a version |
| Runtime prompt assets | `packages/engine/content/` | [`../packages/engine/README.md`](../packages/engine/README.md) names them; `docs/` does not index them |

### The sanctioned duplications

Duplication is not banned here; it is listed. Do not add another copy, and
change each twin together.

1. **`../CONVENTIONS.md` ↔ the memory store.** Declared in that file's own
   preamble: the store is primary, the file is the readable summary. Naming it
   here is what stops someone de-duplicating a rule out of the file.
2. **The architecture picture.** `../README.md` §Why it is shaped this way keeps
   the product form (ASCII, for a reader deciding whether they want this);
   [`CURRENT_STATE_AUDIT.md`](CURRENT_STATE_AUDIT.md) §Runtime shape keeps the
   engineering form (bullets with source links).
3. **The `~/.sdlc` story.** [`reference/state-and-config.md`](reference/state-and-config.md)
   is full; `../README.md` §State is the user-facing table; the plugin README is
   one sentence.
4. **Each workspace's one-line purpose.** Its `package.json` `description` and
   the first line of its README.
5. **The product rails.** `../AGENTS.md` §Product rails carries the load-bearing
   sentence of [`PRODUCT_VISION.md`](PRODUCT_VISION.md) and
   [`PROVIDER_STRATEGY.md`](PROVIDER_STRATEGY.md), never the argument.

## Adding or moving a document

Read before adding or moving anything. These rules are most of what keeps a
flat, duplicative wall of text from growing back.

- **Progressive disclosure.** A fact should be reachable in one hop from its
  gateway. If it takes three, the gateway is wrong.
- **Bounded pages.** Roughly 600 lines is a review signal, not a limit.
  [`BACKLOG.md`](BACKLOG.md) is the declared exception — it is read by ID lookup,
  not top to bottom.
- **Single source of truth.** Before adding a paragraph, ask whether it already
  lives somewhere. If it does, link it. If it needs to live in two places, add it
  to the sanctioned list above with a reason.
- **No hand-maintained counts.** Tool counts, rule counts, test counts and file
  counts come from the tools that produce them. Do not write a number a
  refactor can falsify.
- **No dangling links.** If you rename or remove a document or heading, repoint
  every inbound reference in the same change — including code comments:
  `rg 'old-name' -g '*.md' -g '*.ts' -g '*.rs'`.
- **Where new information goes** — see the fact-type map in
  [`../AGENTS.md`](../AGENTS.md#documentation-ownership).

**Adding a document?** Add it under an existing gateway and link it from here in
the same change. Add a directory under `docs/` only when three or more pages
already want it and no existing gateway is coherent — `docs/` is otherwise flat
on purpose. Add a `reference/` catalog only when a new surface exists, not when
an existing one grows.

`node scripts/check-docs.mjs` enforces the mechanical half of these rules: link
resolution, doc paths named in code, catalog-versus-source parity, orphan pages,
and breadcrumbs.

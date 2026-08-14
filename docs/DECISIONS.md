# Decisions

> [Documentation hub](README.md) · [SDLC](../README.md)

Why an approach was chosen or declined, and what lost. `AGENTS.md` requires a
record whenever an obvious existing option is declined, so this is where that
goes.

These records are also in the store as memories, anchored to the code they
constrain, so they surface through `context` and `recall` without anyone opening
this file. The store is primary; this is the readable summary.

| Decision | Status | Decided |
|---|---|---|
| [Provider-first code intelligence](#provider-first-code-intelligence) | Accepted | 2026-08-06 |
| [Native SQLite through rusqlite inside the existing Rust module](#native-sqlite-through-rusqlite-inside-the-existing-rust-module) | Accepted | 2026-08-12 |
| [First FLOW-001 production slice](#first-flow-001-production-slice) | Accepted | 2026-08-12 |
| [Completed work leaves the backlog](#completed-work-leaves-the-backlog) | Accepted | 2026-08-13 |
| [Context-first retrieval, gated by task outcomes](#context-first-retrieval-gated-by-task-outcomes) | Accepted | 2026-08-13 |

## Provider-first code intelligence

> **Status:** Accepted · **Decided:** 2026-08-06 · **Recorded:** 2026-08-13
> (retrospective; the argument lives in [`PROVIDER_STRATEGY.md`](PROVIDER_STRATEGY.md))

SDLC orchestrates and combines proven code-intelligence providers instead of
reimplementing their language-specific semantic analysis. The engine must not
grow its own production TypeScript project resolver, package resolver,
compiler-reference indexer, universal control-flow graph, or universal data-flow
engine when a maintained provider can supply that information.

The full argument, the initial provider stack, the snapshot and trust rule, the
adoption sequence and the guardrails are the subject of
[`PROVIDER_STRATEGY.md`](PROVIDER_STRATEGY.md) — that document is the decision's
detail rather than a summary of it. This row exists so the decision is findable
from the decision hub.

The consequence recorded elsewhere: the existing TypeScript enrichment stays a
prototype and an evaluation baseline. `packages/engine/src/graph/typed.ts` says
so at the top of the file.

## Native SQLite through rusqlite inside the existing Rust module

> **Status:** Accepted · **Decided:** 2026-08-12 · **Recorded:** 2026-08-13
> (retrospective; text preserved from `PRIOR_ART.md` §Native SQLite implementation decision)

SDLC adopts the MIT-licensed [`rusqlite`](https://github.com/rusqlite/rusqlite)
bindings with bundled SQLite inside its existing Rust N-API module. This reuses
SQLite's maintained transaction, WAL, migration and FTS5 machinery while
preserving the engine's small synchronous database boundary. It also ships in the
same five-platform native artifact matrix the desktop app already verifies.

The obvious alternatives were evaluated rather than reimplemented:

- Node's official [`node:sqlite`](https://nodejs.org/api/sqlite.html) was added
  after the Node 20 runtime embedded by the current Electron baseline, so it
  cannot be the application boundary yet.
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) is mature and
  has an excellent synchronous API, but would introduce a separate
  Node/Electron ABI-specific native artifact and rebuild lifecycle alongside the
  N-API module SDLC already packages.
- [`@vscode/sqlite3`](https://www.npmjs.com/package/@vscode/sqlite3) provides
  maintained Node-API prebuilds, but its asynchronous API would force a broad
  rewrite of the existing synchronous query/transaction call graph while
  retaining app-owned storage orchestration in TypeScript.

The TypeScript `Db` class therefore remains only as a compatibility adapter;
SQLite ownership and persistence are Rust responsibilities. This choice does not
justify custom migration, search, or graph engines: those continue to use
SQLite's proven facilities.

Schema v17 applies that rule to upgrades: `user_version` provides the
compatibility gate, `BEGIN IMMEDIATE` provides atomic DDL rollback,
`quick_check` detects structural corruption, and SQLite's online backup API
captures a consistent recovery image including committed WAL pages. Backups are
written to a unique temporary database, normalized to a standalone DELETE-journal
file, validated, permission-restricted, and atomically renamed before migration.
Only the newest validated image for a target version is retained, which bounds
deterministic retry failures without reusing a stale snapshot. SDLC adds only the
ordered version policy and ledger around those primitives. It deliberately does
not automatically replace a generally corrupted store from an older backup,
because silently losing newer human knowledge is worse than presenting an
explicit recovery choice.

Schema v18 applies the same adoption rule to retrieval, using SQLite's documented
external-content FTS5 pattern and maintenance triggers instead of a custom
inverted index, plus `unicode61`, prefix indexes, `bm25` and `snippet`. The
`search_documents` table is a provenance/lifecycle projection of the
authoritative domain tables; FTS remains a rebuildable access path. One Rust
query boundary normalizes and bounds input so HTTP, MCP, memory recall and the
desktop do not each invent search syntax or ranking. Tantivy, a vector sidecar,
and source-body chunking remain deferred until evaluation shows this baseline
failing a named workload.

QUERY-001 applies the rule again at evaluation time. SDLC does not reproduce
Aider's repository-map graph or PageRank implementation. A digest-pinned map from
Aider 0.86.2 is checked in as the cheap context baseline, and the app-owned
planner is scored against that real artifact at a fixed budget. Aider remains an
evaluation dependency rather than a bundled Python runtime while the first corpus
shows mixed quality and materially higher token use.

Change-aware QUERY-001 retrieval likewise delegates repository state to Git's
stable porcelain v2 status contract. A bounded Rust adapter normalizes that
output into app-owned evidence; SDLC owns the subsequent fusion and ranking, not
a competing diff or worktree implementation.

The operational rule this produced is
[`CONVENTIONS.md` §Schema changes need a migration](../CONVENTIONS.md#schema-changes-need-a-migration).

## First FLOW-001 production slice

> **Status:** Accepted · **Decided:** 2026-08-12 · **Recorded:** 2026-08-13
> (retrospective; text preserved from `PRIOR_ART.md` §First FLOW-001 production decision)

The measured Joern spike validates CPG control-flow concepts but still does not
justify shipping its 2.17 GB, AMD64-only evaluated runtime or translating a full
GraphSON graph for one desktop workflow. The first production flow slice
therefore reuses the already bundled Rust Tree-sitter grammar and existing
resolved-reference store, adding only a bounded SDLC-specific adapter for
explicit HTTP route guards and response effects.

This is adoption plus narrow product semantics, not a substitute for a general
CPG: loops and switches are reported as gaps, data flow is unclaimed, and broader
providers remain subject to the same golden corpus. The measurements behind the
spike are in [`EVALUATION.md`](EVALUATION.md).

## Completed work leaves the backlog

> **Status:** Accepted · **Decided:** 2026-08-13 · **Recorded:** 2026-08-13

This **reverses** a previously stated principle. `docs/README.md` used to say:
*"keep completed backlog items as evidence rather than silently rewriting
history."* The new rule is the opposite — a criterion that is met moves to
[`CHANGELOG.md`](CHANGELOG.md), and an item whose criteria are all met leaves
[`BACKLOG.md`](BACKLOG.md) entirely.

The old rule was correct when it was written, because there was nowhere else for
evidence to go. By 2026-08-13 it had produced the opposite of its intent: the
outcome of shipped work was being recorded in **three** places at once — 18
`Progress (...)` paragraphs inside the backlog, dated `Implementation update`
preambles on the audit, and an `Implementation status` section in the provider
strategy. The backlog was the highest-churn file in the repository and roughly a
third history, and at least one item contradicted itself in tone, with acceptance
criteria saying "must" while its progress paragraph said the same thing remained
open. A reader could not tell what was still open without diffing two paragraphs
— which is the silent staleness `CONVENTIONS.md` §Say what did not happen exists
to forbid.

Alternatives considered:

- **Keep the old rule.** Rejected: it was already failing, and doing nothing
  meant three homes for one fact.
- **Delete on ship with no changelog**, letting `CURRENT_STATE_AUDIT.md` carry
  the shipped narrative. Rejected: the audit answers "how good is this now",
  which is a different genre from "what changed and when". Its accreting dated
  preambles were a symptom of being asked to do both.
- **Delete whole items on ship.** Rejected as too coarse: items here are
  partially shipped, so this would have erased in-flight evidence. Hence the
  rule operates at **criterion** granularity.

Nothing is lost by moving history: git holds the diff, the changelog holds the
outcome, and this file holds the reasoning. The migration was a harvest — no
changelog entry was invented, and no acceptance criterion was deleted.

## Context-first retrieval, gated by task outcomes

> **Status:** Accepted · **Decided:** 2026-08-13 · **Recorded:** 2026-08-13

An external strategic review of the retrieval bet was weighed against the
evidence in [`EVALUATION.md`](EVALUATION.md). Its verdict — the validated
thesis is context-first, not context-only, and the product-level benefit of
`brief` is unproven — was accepted and landed in the backlog and command prose
in the same change:

- **Context-first is not context-only.** `/implement`'s prose said "do not
  read the repository at large" three times while its own tool list kept
  Read, Grep and Glob; the prose now matches the tool policy and
  [`PRODUCT_VISION.md`](PRODUCT_VISION.md).
- **Task outcomes become QUERY-001's promotion gate through EVAL-002**,
  because the retrieval corpus measures brief contents under a budget cap —
  recall ceilings set by the evidence budget, a memory-evidence asymmetry no
  map can win — not whether briefs help an agent finish work. Phase 1 runs on
  TypeScript only, where the audited slice is complete, so a negative result
  indicts the thesis rather than unfinished language support.
- **Failure evidence joins working-tree changes as retrieval seeds**
  (QUERY-001): failing-test output, stack traces, error strings.
- **The progressive surface — QUERY-002's brief_id, expand, and feedback — is
  contract-defined now but built only after the pilot**, with Phase 1
  instrumented from harness transcripts, because the feedback operation it
  would otherwise lean on is part of what the pilot must justify.

Declined, and what lost:

- **An auto-generated Aider-style map as a product capability.** The pinned
  map is the baseline the query must beat; shipping it as a feature would bet
  against the product's own architecture before the measurement is in.
- **Non-code knowledge ingestion (tickets, PRs, CI history).** Deferred in the
  backlog: the evidence model should not be diluted with sources that have no
  anchors in the graph while the anchored sources are still unproven.
- **Artifact handles and lazy tool loading.** The harnesses already provide
  this at the host layer; duplicating it in the engine buys nothing
  measurable.
- **A separate tool-surface-reduction item.** QUERY-001 already carried the
  criterion; it was sharpened to name the target tier rather than duplicated.

The same review prompted a positioning change: the repository was renamed
`code-context-engine`, while the `@sdlc` package scope, plugin name, and state
directory stay unchanged — the category descriptor moved into the repository
identity, not the product internals.

---

## Finding and maintaining decisions

- **Know the topic?** Scan the table above.
- **Need what shipped instead of why?** [`CHANGELOG.md`](CHANGELOG.md).
- **Need the rule that resulted?** [`../CONVENTIONS.md`](../CONVENTIONS.md) keeps
  the imperative and the incident that proves it; this file keeps the
  alternatives and why they lost.
- **Adding one?** One section, one table row, dated. Give `Decided:` the date the
  choice was actually made and `Recorded:` the date it was written down. If the
  decided date cannot be recovered, write `unknown` and say where the text came
  from — never a plausible guess.
- **Never delete a record.** Mark a superseded or reversed decision in place; the
  record that explains the old constraint is the point.

This catalog stays flat and unnumbered. Split it into `decisions/` records with
area catalogs when it passes roughly 40 records or 200 lines — numbering earlier
buys an index nobody needs and an ID collision waiting to happen.

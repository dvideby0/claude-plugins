# Strategy

## The principle

Deterministic tools produce facts. Models produce judgment. Anything a parser
can establish is never asked of a model.

Imports, symbols, line counts, churn, lint errors and type errors are parsed.
Whether an error path is actually handled, whether a test would catch a
regression, whether a trust boundary is validated — that needs a model, and
that is all the model is asked for.

## Pipeline

```
scan ──▶ run_tools ──▶ plan ──▶ context ──▶ agents ──▶ record ──▶ export
 │           │           │                                │
 └───────────┴───────────┴──── audit.db (the store) ◀─────┘
```

1. **scan** — walk the repo, parse every TS/JS/Python file with tree-sitter,
   extract symbols and imports, resolve each import to a real file (relative
   paths, `tsconfig` aliases, Python relative and absolute modules) or to an
   external package.
2. **run_tools** — the project's own eslint / tsc / ruff / mypy, plus an
   in-process secret scan, OSV dependency advisories from your lockfile, and
   import-cycle detection.
3. **plan** — rank files by risk, group them into review units.
4. **context** — build each unit's prompt as a query against the store.
5. **agents** — sub-agents review and call `audit_record_findings`.
6. **export** — reports and `TASKS.json` are generated from the store.

## The store

One SQLite file, `sdlc-audit/audit.db`:

| Table | Holds |
|---|---|
| `files` | path, language, LOC, content hash, churn, is-test |
| `symbols` | functions, classes, methods, interfaces — with line spans |
| `edges` | one row per import: source file, specifier, resolved target or package |
| `findings` | fingerprint, rule, severity, status, first/last seen |
| `suppressions` | accepted risks and false positives |
| `runs`, `tool_runs` | history, and what each tool did on each run |

The graph is a table of edges, so reachability, cycles and blast radius are
SQL — no separate graph database.

## Findings have identity

A fingerprint is `hash(rule, file, enclosing symbol, normalized code)`.
Whitespace and numeric literals are normalized out, and line numbers are
excluded entirely.

That gives a lifecycle instead of a snapshot:

- **open** — currently reported
- **fixed** — a tool that ran successfully stopped reporting it
- **regressed** — it came back after being fixed
- **accepted** / **false_positive** — a human decided; sticky forever

Two rules keep this honest. A tool only closes findings under its own rule
prefix, and only when it actually ran — a skipped linter never marks its
previous findings fixed. And a model pass over three files never closes
findings anywhere else.

## Incrementality

Every file carries a content hash. On a re-run, unchanged files keep their
symbols, edges and findings; only changed files are re-parsed. Deleted files
retire their graph and close their findings.

Import edges are re-resolved on every scan, so adding a file can resolve an
import that was external last time.

## Risk model

Risk decides where tokens go, and it is computed *before* the review pass:

```
risk = 30% blast radius (importers)
     + 25% open findings (severity-weighted)
     + 20% churn (commits, 6 months)
     + 15% no importing test
     + 10% size
```

Size is deliberately the smallest term — a large file is not automatically a
risky one. Files are grouped into review units within a directory, sized to
the context budget, and the highest-risk units go first.

## Context engineering

Context is assembled by query, in priority order, packed to a budget:

1. What this unit is and why it was selected
2. Review rules for the languages present, plus an optional lens
3. **Findings already known for these files** — so agents don't re-report what
   the linters found
4. Graph neighbourhood — who imports these files, and the exported signatures
   of what they import, so a reviewer sees the contract without reading the
   dependency
5. Source, line-numbered, highest-risk first; anything that doesn't fit is
   listed by name

Agents pull rather than receive: `audit_query` answers symbol lookups,
importers, imports, findings, hotspots, externals and cycles on demand.

Findings are written through `audit_record_findings`, which validates at the
tool boundary, fingerprints on arrival, applies suppressions, and reports
duplicates back. Agents cannot write to the store any other way, and cannot
claim a finding came from a linter.

## Packaging

The server is one bundled file, and SQLite and the tree-sitter grammars ship as
wasm in `server/vendor/`. There is no install step and no network at runtime,
except the optional OSV advisory lookup.

Linters are deliberately *not* bundled: they must match the project's own
config and version. If a project has no eslint, the tool reports `skipped`
with the reason. A skipped tool is never presented as a clean one.

## Scope

TypeScript, JavaScript and Python. Other languages are indexed as files but
not parsed, so they contribute no symbols or edges.

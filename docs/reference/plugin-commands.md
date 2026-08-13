# Plugin commands

> [Reference](README.md) · [Documentation hub](../README.md)

The commands the SDLC companion plugin adds to a coding harness. Each links to
the prompt file that is the command, and each row quotes that file's own
`description:` frontmatter.

These files are shipped product assets, validated in CI by
`claude-code plugin validate --strict`. They are the canonical record of what a
command does — this page is a catalog, not a second copy.

The commands need a running engine. Setup is in
[`../../plugins/sdlc/README.md`](../../plugins/sdlc/README.md).

## Understanding and planning

| Command | What it does |
|---|---|
| [`/understand`](../../plugins/sdlc/commands/understand.md) | Explain how something works in this codebase, grounded in the indexed graph and everything previous sessions recorded about it |
| [`/plan`](../../plugins/sdlc/commands/plan.md) | Plan a change against the real structure of this codebase — where it goes, what it touches, and what constrains it |
| [`/brainstorm`](../../plugins/sdlc/commands/brainstorm.md) | Think through a design against what this codebase already is and already decided, then record the outcome |
| [`/grill`](../../plugins/sdlc/commands/grill.md) | Interview the user about a part of the system until the domain model is clear, then record it against the code |

## Changing code

| Command | What it does |
|---|---|
| [`/implement`](../../plugins/sdlc/commands/implement.md) | Implement a change through subagents, each briefed by the engine rather than by reading the codebase, and verified against what actually depends on the code |
| [`/debug`](../../plugins/sdlc/commands/debug.md) | Find the root cause of a bug by following the graph rather than guessing, then record it so it is never re-diagnosed |
| [`/handoff`](../../plugins/sdlc/commands/handoff.md) | Persist where this session got to, into the store rather than a summary — so the next session, in any harness, picks it up by asking |

## The map

| Command | What it does |
|---|---|
| [`/map`](../../plugins/sdlc/commands/map.md) | Turn the machine's index into the map a person would draw — named regions, real flows, annotations — and afterwards keep only what moved up to date |
| [`/enrich`](../../plugins/sdlc/commands/enrich.md) | Go where the index cannot see, read the code, and write back the edges a parser could never derive |

## Audit

| Command | What it does |
|---|---|
| [`/audit-quick`](../../plugins/sdlc/commands/audit-quick.md) | Fast deterministic scan — index the repo, run your linters and type checkers, secret scan and dependency advisories. No sub-agents |
| [`/audit`](../../plugins/sdlc/commands/audit.md) | Full repository audit — index, run your tools, review the riskiest code with sub-agents, and record what was learned |
| [`/audit-security`](../../plugins/sdlc/commands/audit-security.md) | Security-focused audit — secrets, dependency advisories, and sub-agent review of the riskiest code through a security lens |

---

The command set is canonical in `plugins/sdlc/commands/`; this catalog must
list every file there and nothing else, which `node scripts/check-docs.mjs`
enforces. Documentation placement rules live in the
[documentation hub](../README.md).

---
description: Implement a change through subagents, each briefed by the engine rather than by reading the codebase, and verified against what actually depends on the code
allowed-tools: Task, Read, Edit, Write, Bash, Grep, Glob, AskUserQuestion, mcp__sdlc__brief, mcp__sdlc__context, mcp__sdlc__impact, mcp__sdlc__references, mcp__sdlc__recall, mcp__sdlc__remember, mcp__sdlc__audit_query, mcp__sdlc__audit_scan
---

# Implement: $ARGUMENTS

Work is split across subagents so that no single context accumulates the whole
job. The thing that makes that work here is that a subagent does **not** have
to read the codebase to understand its task — the engine briefs it.

## 1. Get task context, then scope

Call `brief` with the full task, `intent: implement`, and any targets already
known. It ranks lexical matches, graph neighbours, flows, tests, findings,
memories, and bounded source excerpts inside the requested byte budget. If no
target is known, use the task-first form; do not grep the repository just to
manufacture one. Follow its uncertainty and recommended reads with `context`,
`references`, or `impact` only when needed.

If a previous session already recorded a decision, follow it or explicitly
supersede it — do not silently re-decide. If the result says a target is
ambiguous, refine it rather than guessing. Ambiguity discovered in task three
costs all of tasks one and two.

## 2. Break it into tasks

Each task must be:

- **One concern.** If the title needs "and", split it.
- **Anchored.** Name the exact files surfaced by the task context. If none are
  credible, refine the task or ask rather than reading the repository at large.
- **Verifiable.** State the command that proves it worked, or the behaviour to
  observe. "It compiles" is not verification.
- **Ordered.** Note which tasks depend on which. Independent ones can run
  together.

Show the list and get agreement before dispatching anything.

## 3. Brief, then dispatch

For each task, call `brief` with its task description, `intent: implement`, the
known target files or symbols, and a byte budget appropriate to the task. It
returns ranked evidence, exact source/fact references, freshness, omissions,
uncertainty, and focused follow-up reads. Do not hide an omitted or stale
section from the subagent.

Dispatch a subagent with `Task`, and give it:

1. The task, and its verification command.
2. The `brief` text, verbatim.
3. The `readFirst` paths — where to start, so it does not go hunting.
4. This instruction: *call `context` or `references` if you need more; do not
   read the repository at large.*

Why this way: a subagent that greps its way to understanding spends most of its
window before it edits anything, and still misses constraints because they are
not in the files. The briefing has a measured byte ceiling and says what it
could not fit instead of silently overflowing the context.

Run independent tasks in parallel — one message, several `Task` calls.

Keep your own context tidy. You are the orchestrator: hold the plan, the task
states and the verification results. Do not pull each subagent's full working
detail back into your context; keep what changed and whether it passed.

## 4. Verify against what actually depends on it

For every file touched, `impact` gives the call sites and the covering tests.

- Run those tests. Not the whole suite first — the ones that cover this.
- If `impact` reports **no test covers it**, say so plainly and either add one
  or get explicit agreement to proceed without.
- If a signature changed, `references` lists every call site. Check them. The
  count is the number of places that must be right, and you can enumerate them.

Then run the project's own checks. Report failures verbatim; never summarise a
failing test as "mostly working".

## 5. Re-index and record

Run `audit_scan` so the graph reflects the new code, then `remember` what the
work established:

- `decision` — the approach taken and what was rejected
- `constraint` — anything the next change must not break
- `todo` — work deliberately deferred, so it is not lost

Anchor to the symbol where one applies. Report what you recorded in one line
each.

## Stop conditions

Stop and ask if: the plan needs to change materially, a task fails twice for
the same reason, or verification reveals the request was underspecified.
Continuing past any of those produces work that has to be redone.

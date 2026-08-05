---
description: Plan a change against the real structure of this codebase — where it goes, what it touches, and what constrains it
allowed-tools: Read, Grep, Glob, AskUserQuestion, mcp__sdlc__context, mcp__sdlc__recall, mcp__sdlc__remember, mcp__sdlc__audit_query, mcp__sdlc__audit_status
---

# Plan: $ARGUMENTS

Produce a plan grounded in what this codebase actually looks like, not in what
a codebase like this usually looks like.

## 1. Recall before deciding

Call `recall` with the key nouns from the request. Prior `decision` and
`constraint` memories often settle a design question before you open a file —
and re-litigating a decision someone already made is the most expensive mistake
available here.

## 2. Find where it goes

Locate the code this touches:

- `audit_query` with kind `symbol` to find a definition by name.
- `audit_query` with kind `hotspots` for the most depended-on files, when the
  change is architectural.
- `context` on each candidate area.

Prefer following the resolved graph over grepping.

## 3. Work out the blast radius

For every file you plan to change, `context` gives its `importers`. That list
is the blast radius: those are the call sites a signature change breaks and the
tests that should catch it.

Say plainly when the radius is large. "This touches 14 importers" changes how a
person wants the work done.

## 4. Check what is already wrong there

Open findings on the files you are about to touch, from `context`. Pre-existing
problems in code you are modifying are either in scope or explicitly deferred —
decide which, and say so, rather than silently inheriting them.

## 5. Write the plan

- **Approach** — one paragraph, and why this way over the obvious alternative.
- **Changes** — per file: what changes, and whether it is new, edited, or moved.
- **Blast radius** — importers affected, tests that cover them.
- **Constraints** — recalled memories that bound the design, quoted, with the
  reason attached.
- **Risks** — open findings in the affected code, and anything the index cannot
  tell you.
- **Not doing** — what you are deliberately leaving out.

Where a real fork exists, use `AskUserQuestion` rather than picking silently.

## 6. Record the decisions

Once the user has agreed, `remember` the decisions that were actually made and
their reasons, anchored to the files involved:

- `decision` for the approach chosen and what was rejected
- `constraint` for anything the next change must not break
- `todo` for work knowingly deferred

This is what stops the next session — yours or someone else's — from reopening
a settled question.

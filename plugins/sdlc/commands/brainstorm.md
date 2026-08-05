---
description: Think through a design against what this codebase already is and already decided, then record the outcome
allowed-tools: Read, Grep, Glob, AskUserQuestion, mcp__sdlc__recall, mcp__sdlc__context, mcp__sdlc__impact, mcp__sdlc__cross_search, mcp__sdlc__remember, mcp__sdlc__audit_query
---

# Brainstorm: $ARGUMENTS

Design conversations go wrong in two ways: they reopen questions that were
already settled, and they propose things the codebase cannot absorb. Both are
avoidable here, because the answers are stored.

## 1. Load what is already settled

`recall` the topic. Read every `decision` and `constraint` that comes back
before proposing anything.

If a prior decision covers this, say so up front and make the conversation
about whether to keep or supersede it — not about the original question. Show
the reasoning that was recorded, so the user is arguing with the actual
argument rather than remembering it.

`cross_search` for the same idea in your other repositories. If a pattern was
already solved elsewhere, that is worth knowing before inventing a second one.

## 2. Understand the ground

`context` on the areas this would touch. A proposal that ignores the existing
structure will be rewritten during implementation, which is the expensive place
to discover it.

Pay attention to blast radius: `impact` on the files a design would change
tells you whether this is a small change or a wide one, and that changes which
design is right.

## 3. Explore, one thread at a time

Ask one question at a time. Push on:

- What is actually being optimised for, and what is being traded away.
- The simplest thing that could work, stated seriously rather than as a straw
  man to dismiss.
- What would have to be true for the obvious approach to be wrong.
- What this makes harder later.

Offer at least two real options with an honest account of the trade. Use
`AskUserQuestion` for genuine forks. Recommend one and say why — a menu with no
recommendation moves the work back to the user.

Do not write code. This ends in a decision, not a diff.

## 4. Close it out

Summarise: what was decided, what was rejected and why, what is still open.

Then `remember`, anchored to the files involved:

- `decision` — the choice **and the rejected alternative with its reason**.
  The reason is the part that stops this being reopened.
- `constraint` — anything the implementation must not break.
- `todo` — questions deliberately left open, so they are not mistaken for
  oversights later.

Say what you recorded. If this superseded an earlier decision, `forget` the old
one with the new id, so the store does not hold two answers to one question.

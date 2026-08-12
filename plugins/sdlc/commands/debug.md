---
description: Find the root cause of a bug by following the graph rather than guessing, then record it so it is never re-diagnosed
allowed-tools: Read, Grep, Glob, Bash, Edit, mcp__sdlc__context, mcp__sdlc__references, mcp__sdlc__impact, mcp__sdlc__brief, mcp__sdlc__recall, mcp__sdlc__remember, mcp__sdlc__audit_query
---

# Debug: $ARGUMENTS

The failure mode to avoid is changing things until the symptom disappears. That
produces a fix nobody can explain and a bug that comes back wearing a different
hat.

## 1. Has this happened before?

Call `brief` with the complete symptom or error text, `intent: debug`, and any
known failing target. It searches recorded gotchas, open findings, execution
flows, graph neighbours, tests, and source ranges together. A diagnosis from an
earlier session is the cheapest possible fix, and previous sessions were told
to record exactly this. Follow its recommended reads; use `context` or
`references` only when the returned uncertainty requires a deeper query.

## 2. Reproduce it

Get a command that fails, reliably, and paste the actual output. If you cannot
reproduce it, say so and ask for the conditions — everything after this point
is worthless without it.

## 3. Follow the graph to the cause

State what you believe is happening in one sentence, then test that belief.

- `references` on the suspect symbol gives **every** call site. Read the ones
  passing the input that breaks. This is the step people usually replace with
  a grep and get wrong, because a grep finds the name, not the uses.
- `context` on each file involved: its imports are where its assumptions come
  from, its recorded constraints are what it was supposed to guarantee.
- Follow the data. A wrong value has a source; walk back through the call sites
  until you reach where it becomes wrong.

Two rules:

- **Do not fix anything yet.** A fix applied before the cause is understood
  hides evidence.
- **Explain the symptom entirely.** If your theory accounts for the crash but
  not the warning that preceded it, the theory is incomplete.

## 4. Prove it

Before changing code, make the cause visible: a failing test that asserts the
correct behaviour, or an observation that only holds if you are right. Then
fix, and watch it turn.

If you cannot write a test that fails first, say so and explain what you
verified instead.

## 5. Check the blast radius

`impact` on every file you changed. If the same wrong assumption is made at
other call sites, fix those too or list them explicitly — a bug that exists in
five places and is fixed in one will be reported again next week.

Run the covering tests `impact` names, then the project's checks. Report
failures verbatim.

## 6. Record it

`remember` the root cause as a `gotcha`, anchored to the symbol that was wrong
— not the file, if a symbol will do:

- What looked correct
- Why it was not
- What the correct invariant is

If the bug was possible because nothing enforced something, record that as a
`constraint` too. This is the whole point: a bug diagnosed once should never
cost that again, and the next session gets it automatically through `context`
without knowing to ask.

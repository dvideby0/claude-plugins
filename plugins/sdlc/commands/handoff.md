---
description: Persist where this session got to, into the store rather than a summary — so the next session, in any harness, picks it up by asking
allowed-tools: Bash, Read, mcp__sdlc__remember, mcp__sdlc__recall, mcp__sdlc__context, mcp__sdlc__impact, mcp__sdlc__audit_scan, mcp__sdlc__audit_status
---

# Handoff

Sessions end. What was learned should not.

A summary in the transcript is lost the moment the window closes, and a handoff
file has to be found and read by someone who does not know it exists. Writing
to the store instead means the next session gets it by asking `context` about
the code it is already touching — no one has to know to look.

## 1. Establish what actually happened

Do not reconstruct this from memory of the conversation. Check:

- `git status` and `git diff --stat` — what changed on disk.
- `audit_status` — whether the index reflects it.
- Test and check results, if any were run.

If the working tree has changes the index does not know about, run
`audit_scan` first. A handoff that describes code the store cannot see is half
a handoff.

## 2. Separate the three kinds of thing

**Durable** — true beyond this session. Goes in the store:

- `decision` — what was chosen and what was rejected, with the reason
- `constraint` — what must not be broken
- `gotcha` — a trap found the hard way
- `todo` — work deliberately left, with enough detail to pick up cold

**Situational** — true only right now. Goes in your reply, not the store:
what is half-finished, which test is currently failing, what you were about to
try. Recording these as memories pollutes the store, because they stop being
true in an hour.

**Neither** — narration of what you did. Git already has it. Skip.

## 3. Record the durable parts

Anchor every memory to the files it concerns, and to the symbol where one
applies. An unanchored memory only surfaces if someone searches the right
words; an anchored one surfaces automatically when anyone touches that code.

For each `todo`, include what a cold reader needs: which file, what is missing,
and how to tell when it is done.

Keep it to a handful. Ten sharp memories beat forty vague ones, and the store
is read by an agent with a budget.

## 4. Report the situational parts

End your reply with:

- **State of the tree** — changed files, whether they build, whether tests pass
- **In progress** — what is half-done and what the next concrete step is
- **Blocked on** — anything needing a decision or access you do not have
- **Recorded** — one line per memory, so the user can correct a wrong one now

If anything is failing, say so plainly with the output. A handoff that reads
better than the truth is worse than no handoff, because it will be believed.

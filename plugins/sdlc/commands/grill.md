---
description: Interview the user about a part of the system until the domain model is clear, then record it against the code so it does not have to be explained again
allowed-tools: Read, Grep, Glob, AskUserQuestion, mcp__sdlc__context, mcp__sdlc__recall, mcp__sdlc__remember, mcp__sdlc__references, mcp__sdlc__audit_query
---

# Grill: $ARGUMENTS

Most of what makes a codebase hard is not in the codebase. It is the vocabulary
the team uses, the invariants nothing enforces, the reason the obvious approach
was rejected. This gets that out of the user's head and anchors it to the code
it describes.

## 1. Find out what is already known

`recall` the topic first, and `context` on any file or symbol named. Never ask
the user something the store already answers — that is the fastest way to make
this feel like a form.

Open the code before asking anything. Questions grounded in what you have read
are worth answering; generic ones are not.

## 2. Interview

Ask **one question at a time** and wait. A list of six questions gets one
answer.

Aim at what the code cannot tell you:

- **Vocabulary** — "you called that a *unit*; is that the same as a review
  unit in the code, or something else?" Naming mismatches between speech and
  code cause more confusion than any algorithm.
- **Invariants** — "what must always be true here that nothing checks?"
- **Rejected paths** — "what is the obvious way to do this, and why is it
  wrong?" This is the highest-value question in the interview.
- **Failure** — "what breaks when this goes wrong, and how would you notice?"
- **Boundaries** — "what is deliberately not this component's job?"

Follow the answer that surprises you. When the user says something you would
not have guessed from the code, that is exactly the thing worth recording.

Use `AskUserQuestion` when there are a few concrete alternatives; plain prose
otherwise.

Stop when you can restate the design in your own words and the user agrees.
Say the restatement out loud and let them correct it — that is the check.

## 3. Record it against the code

Do not write a glossary file. A file has to be found, read and trusted, and it
rots silently. Anchor each item with `remember` to the file — and the symbol,
where one applies — so it comes back automatically the next time anyone asks
for `context` on that code.

- `decision` — a choice and the alternative rejected, with the reason
- `constraint` — what must not be done, phrased as a rule
- `gotcha` — what looks correct and is not
- `context` — vocabulary and background that would take an hour to reconstruct

Rules for what goes in:

- One idea per memory, titled as a sentence someone would search for.
- Anchor to the narrowest true scope. `#getDb` beats the file; the file beats
  nothing.
- Record the **why**, not the what. The what is in the code.
- Do not record what the code plainly says.
- Do not record anything the user did not actually confirm.

## 4. Show what you stored

List each memory as `kind: title → anchors`. Ask whether anything is wrong or
missing, and fix it now — a wrong memory is worse than none, because it will be
believed later.

If `context` showed existing memories marked stale, raise them: the code moved
after they were written, and this is the moment to confirm or supersede them.

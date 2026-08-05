---
description: Explain how something works in this codebase, grounded in the indexed graph and everything previous sessions recorded about it
allowed-tools: Read, Grep, Glob, mcp__sdlc__context, mcp__sdlc__recall, mcp__sdlc__remember, mcp__sdlc__audit_query, mcp__sdlc__audit_status
---

# Understand `$ARGUMENTS`

Explain how this works. Ground every claim in the index or in the file — never
in a guess about a file you have not opened.

## 1. Ask what is already known

Call `context` with `$ARGUMENTS`. It accepts a path, a bare filename, or a
symbol name, and returns the file, its symbols, what imports it, what it
imports, open findings, and memories recorded against it.

If `candidates` comes back, the name was ambiguous — show the user the list and
ask which one before continuing.

Then call `recall` with the same term for anything not anchored to a specific
file. Read `nearbyMemories` too: a constraint recorded on a dependency is a
constraint on this code.

If `context` returns `kind: "unknown"`, the repository may not be indexed. Check
`audit_status` and offer to index before falling back to Grep.

## 2. Read the code

Open the file itself, plus the two or three most important importers — those
show how it is actually used, which is usually more informative than the
definition. Prefer following `importers` and `imports` from step 1 over
grepping; the graph is already resolved.

## 3. Explain it

Cover, in this order:

- **What it is** — its job in one or two sentences.
- **How it is used** — who calls it and why, citing real importers.
- **The shape** — key symbols and the flow between them, with `file:line`.
- **What constrains it** — memories of kind `decision`, `constraint` and
  `gotcha`, quoted. Say when a memory is marked stale, and that it was written
  against an older version of the file.
- **What is already known to be wrong** — open findings on these files.

Cite `path:line` throughout so the user can jump straight there.

## 4. Leave the codebase easier to understand next time

If you worked something out that the code does not say on its own — why it is
built this way, an invariant nothing enforces, a trap you nearly fell into —
record it with `remember`, anchored to the files it applies to:

- `decision` — why it is this way
- `constraint` — what must not be done, and why
- `gotcha` — what looks safe and is not
- `context` — background that would take a while to reconstruct

Do not record what the code plainly says. Do not record anything you did not
verify. Tell the user what you recorded, in one line.

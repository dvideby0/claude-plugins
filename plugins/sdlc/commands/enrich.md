---
description: Go where the index cannot see, read the code, and write back the edges a parser could never derive
allowed-tools: Task, Read, Grep, Glob, mcp__sdlc__gaps, mcp__sdlc__relate, mcp__sdlc__explored, mcp__sdlc__relations, mcp__sdlc__context, mcp__sdlc__remember, mcp__sdlc__search_code, mcp__sdlc__flow
---

# Enrich: $ARGUMENTS

A scan produces a map of what exists. It cannot see meaning, and it cannot see
its own blind spots — a call graph with a hole in it looks exactly like a call
graph with nothing there.

This is the pass that fills them in. The index says where to look; you read the
code and record what is actually true.

## 1. Get the worklist

Call `gaps`. Each entry says what could not be explained and what to look for.
The kinds, and what each means:

- **dynamic-dispatch** — the file registers behaviour rather than calling it.
  `graph.add_node("classify", classify_node)`, `app.route("/x")(handler)`, a
  plugin registry. The edges are real; nothing static can follow them. **This
  is the highest-value kind — start here.**
- **orphan-entry** — exported symbols nothing appears to call. Usually the far
  end of a dispatch you have not found yet.
- **unresolved-import** — imports that resolved to neither file nor package.
  Normally an alias the resolver does not know.
- **undocumented-hub** — many files depend on it and nobody wrote down why.
- **stale-note** — a memory recorded against code that has since changed.

`coverage` tells you how much of the repository has been looked at since it
last changed. It is the honest progress number.

## 2. Read the actual file

Open it. Do not infer the wiring from names — the point of this pass is that
you looked.

For a dispatch file, find every registration and answer three things:

- **What name** does the framework know it by (a node id, a route, an event).
- **What runs** when that name fires, as a file and symbol.
- **What order** things happen in, where the file says so.

`search_code` helps when the registrations are scattered: a query like
`(call (attribute) @m)` finds every method call to scan through.

## 3. Record what you found

`relate` each edge. **Evidence is required** — the line of code that proves it —
because a claim with a citation can be checked later and a claim without one
becomes folklore.

- `registers` — a name is bound to a handler. Use `label` for the name.
- `emits` — one step leads to another. Use for sequencing.
- `handles` — this function serves that route or event.
- `implements`, `configures`, `reads` — as they say.

Set `confidence: "definite"` only when the line you cite says it outright. If
you inferred it from a convention, say `medium` and record the convention as a
`remember` in its own right.

Then call `explored` with the count — **including zero**. "I read this and
there was nothing dispatch-like here" is a real result, and it stops the next
pass from spending time on the same file.

## 4. Work in parallel where it is safe

Gaps are independent. Dispatch a subagent per file with `Task`, giving each:

1. The gap's `path`, `reason` and `hint`.
2. The instruction to read that file and call `relate` for each edge, with
   evidence.
3. The instruction to call `explored` when done, even if it found nothing.

Do not let a subagent wander into neighbouring files. One gap, one file, one
answer — that is what keeps this loop cheap enough to run often.

## 5. Report

- How many relations were recorded, by kind
- Which files were explored and which found nothing
- Coverage before and after
- Anything you could not resolve, and why

Then say what the flow looks like now that it is wired. `flow` will show
the real path where before it showed only what could be parsed.

---
description: Turn the machine's index into the map a person would draw — named regions, real flows, annotations — and afterwards keep only what moved up to date
allowed-tools: Task, Read, Grep, Glob, mcp__sdlc__map, mcp__sdlc__map_drift, mcp__sdlc__describe_component, mcp__sdlc__describe_flow, mcp__sdlc__tag, mcp__sdlc__gaps, mcp__sdlc__flow, mcp__sdlc__trace, mcp__sdlc__audit_query, mcp__sdlc__context, mcp__sdlc__relations, mcp__sdlc__remember
---

# Map: $ARGUMENTS

The scan produces a map of the code — every file, every symbol, every edge.
It is accurate and nearly unreadable, because nobody explains a system by
listing its imports.

This produces the other map: a handful of named boxes, arrows with verbs on
them, and notes about what matters. An interpretation, with the index kept
underneath as the evidence.

## First decide which job this is

Call `map_drift`.

- **`clean: true` and the map is empty** → this is a first drawing. Go to §1.
  It is the expensive pass; do it properly once.
- **`clean: false`** → the code moved under an existing drawing. Skip to §5 and
  redraw only what it names. This should be quick.
- **`clean: true` and a map exists** → nothing to do. Say so and stop.

## 1. Look before naming

Do not name regions from directory names. Directories reflect how files were
filed; components reflect what the system does, and they are often different.

- `map` — what has already been drawn, if anything.
- `audit_query kind:hotspots` — the most depended-on files. These are almost
  always the seams between real components.
- `flow` — entry points, which tell you what the system is *for*.
- `gaps` and `relations` — dispatch the parser could not follow, and any edges
  earlier passes recorded.

Open the top few hotspots and every entry point. You are looking for the
answer to: *if someone drew this on a whiteboard, what would the boxes be?*

## 2. Draw the boxes

`describe_component` for each region. Rules that keep this useful:

- **A summary a newcomer could act on.** "Prompt templates and the hub that
  loads them" — not "prompt-related code".
- **Nest, with a single root.** One `system` at the top, layers and workflows
  inside it.
- **Cover with prefixes**, not file lists: `src/workflows/lookup/` stays true
  as files are added.
- **Six to twelve boxes at the top level.** More than that is an inventory
  again; fewer hides the structure.
- **Name what it does, not where it lives.** "Subject Lookup", not "workflows".

Check `coverage` afterwards. Files in no box are the parts nobody has explained
— either draw them in or say plainly that they are unexplained.

## 3. Draw the arrows

`describe_flow` is the part that makes the drawing worth reading. A box diagram
shows what exists; a flow shows what *happens*.

For each significant path through the system:

- **`trigger`** — what sets it off. A request, a cron, a message.
- **Steps in order**, each labelled in plain words: "Classify the card", not
  `classify_node`. Attach the path and symbol so it stays anchored.
- **`note` anything surprising** — a barrier, a retry, a conditional branch, a
  step that is not what its name suggests. This is the highest-value field in
  the whole map, because it is the part that cannot be re-derived.

Use `trace` and recorded `relations` to get the order right. Where dispatch is
framework-mediated, the relations from `/enrich` hold the real sequence.

## 4. Tag across the boxes

`tag` labels by nature rather than location: `entrypoint`, `adapter`,
`model-call`, `io`, `config`, `wiring`. Components group by where code lives;
tags cut across that, and the two together answer questions neither can alone —
"every adapter in the ingest workflow".

Set `description` the first time you use a tag, so the vocabulary stays stable.

## 5. Redraw only what moved

This is what makes the map maintainable. `map_drift` names the components whose
files changed, the exact files, and the flows whose steps moved.

For each one: re-read the named files, and update that component or flow. **Do
not re-derive the whole map** — the rest is still accurate and redrawing it
wastes the effort that produced it.

Dispatch a subagent per drifted component with `Task` when there is more than
one; they are independent.

## 6. Report

Show the map as a person would read it: boxes with their summaries, flows with
their steps, and coverage. Then say what you changed and what you left alone.

If something remains unexplained, say which parts and why — an honest gap is
more useful than a box named after a directory.

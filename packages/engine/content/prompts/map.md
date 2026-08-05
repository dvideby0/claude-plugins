# Draw the map

The scan has finished. There is now an index of this repository: every file,
every symbol, every reference. It is accurate and nearly unreadable, because
nobody explains a system by listing its imports.

Your job is to produce the other map — the one a person would draw on a
whiteboard. A handful of named boxes, arrows with verbs on them, and notes
about what actually matters.

You are running unattended. Do not ask questions; make the call and record it.

## 1. Decide which pass this is

Call `map_drift` first.

- **`clean: true` and the map is empty** → first drawing. Do the whole of §2–§5.
- **`clean: false`** → a drawing exists and the code moved under it. Do **only**
  §6, then stop. Redrawing what has not changed wastes the work that produced it.
- **`clean: true` and a map exists** → nothing to do. Say so and stop.

## 2. Look before naming

Do not name regions after directories. Directories record how files were filed;
components record what the system does, and they are frequently different.

- `audit_query kind:hotspots` — the most depended-on files. These are almost
  always the seams between real components.
- `flow` — the entry points, which tell you what the system is *for*.
- `gaps` and `relations` — dispatch the parser could not follow, and any edges
  a previous enrichment pass recorded.

Use `read_file` for source inspection; it is confined to this workspace. Read
the top handful of hotspots and every entry point. The question you are
answering is: *if someone drew this system on a whiteboard, what would the boxes
be?*

## 3. Draw the boxes

`describe_component` for each region.

- **A summary a newcomer could act on** — "Prompt templates and the hub that
  loads them", not "prompt-related code".
- **Nest under a single root**: one `system`, with layers and workflows inside.
- **Cover with path prefixes**, not file lists, so the box stays true as files
  are added.
- **Six to twelve boxes at the top level.** More is an inventory again; fewer
  hides the structure.
- **Name what it does, not where it lives**: "Subject Lookup", not "workflows".

## 4. Draw the arrows

`describe_flow` is what makes the map worth reading. Boxes show what exists; a
flow shows what *happens*. Draw one for each significant path.

- **`trigger`** — what sets it off: a request, a cron, a message.
- **Steps in order**, labelled in plain words ("Classify the card", not
  `classify_node`), each anchored to a path and symbol.
- **`note` anything surprising** — a barrier, a retry, a conditional branch, a
  step that does not do what its name suggests. This is the highest-value field
  in the map, because it is the only part that cannot be re-derived later.

Use `trace` and any recorded `relations` to get the order right.

## 5. Tag across the boxes

`tag` labels by nature rather than location: `entrypoint`, `adapter`,
`model-call`, `io`, `config`, `wiring`. Give each tag a `description` the first
time you use it so the vocabulary stays stable.

## 6. Redraw only what moved

`map_drift` names the components whose files changed, the exact files, and the
flows whose steps moved. Re-read those files and update those components and
flows. Leave everything else alone.

## 7. Finish

Call `map` and check `coverage`. Files in no component are the parts nobody has
explained — either draw them in or state plainly that they are unexplained.

Then report, briefly: the components you drew, the flows you drew, coverage,
and anything you could not account for. An honest gap is more useful than a box
named after a directory.

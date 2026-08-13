# Engine design

> [Documentation hub](README.md) · [SDLC](../README.md)

The store is memory, not a report. An audit is one thing that writes to it;
everything else reads from it while work is happening.

A memory carries the content hash of the file it was written against, so a note
about code that has since changed is flagged rather than trusted.

The tools themselves are catalogued in
[`reference/mcp-tools.md`](reference/mcp-tools.md); this page is why each
capability exists and what it cannot do.

## Symbol-level references

`edges` records which files import which. `refs` records which *lines* use which
*symbol*, so `impact` can say that a file with 6 importers exposes one export
used 12 times and another used never.

Two passes, because precision and speed want different tools.

The **fast pass** runs in Rust during every scan and resolves imported names: a
name imported from a module and used in the body resolves to that module's
definition. It covers exported functions, classes and constants, and costs
nothing on top of parsing.

The prototype **typed pass** (`resolve_types`) runs the TypeScript type checker and
resolves what the first cannot — `db.run(...)`, where the method belongs to an
inferred type and nothing was imported by that name, plus type positions. On
this repository it lifts `flush` from 0 references to 11 and `Db` from 0 to 61.
It is a full type-check, so it runs after indexing rather than during it; a
daemon can afford that, a server spawned per session cannot.

This direct compiler integration is useful prototype capability, not the
production semantic-indexing architecture. Future precise navigation follows
the [provider strategy](PROVIDER_STRATEGY.md): evaluate and import a
maintained SCIP or compiler provider tied to a verified source snapshot, retain
Tree-sitter as the resilient fallback, and avoid expanding SDLC's own language
resolver. Today the prototype is TypeScript and JavaScript only — Python stays
import-resolved.

Where nothing resolves a symbol, the tools say **"uses not tracked"** rather
than "unused". Reporting unknown as zero is how someone deletes live code.

## Flow, not just clusters

A force-directed graph answers "what is near what". It has no direction, so it
cannot answer "where does a request start and where does it end up".

`flow` lays the call graph out in layers from its entry points — the callable
symbols nothing else calls, which in practice are route handlers, CLI commands
and exported API. Depth is the longest path from an entry, so a function always
appears to the right of everything that reaches it.

Shared utilities are what ruin these diagrams: a logger called from forty
places drags edges across every column. Anything called from six or more
distinct symbols is pulled into a commons lane and its edges are dashed.

In the app it is the **Flow** tab — entry points on the left, the graph beside
them, zoom and pan, and double-click to re-root on any node.

## Search by shape

`search_code` runs a tree-sitter query across the repository in Rust. A regex
finds the word `catch` and cannot tell an empty handler from a careful one; a
structural match can, because it matches the parse tree.

Named patterns cover the common questions (`swallowed-errors`, `throws`,
`python-bare-except`, `any-annotations`, …); a raw tree-sitter query covers
everything else. A `text` filter applies after the structural match, since
shape and content together are usually what the question needs.

## Two maps

The scan produces the machine's map: files, symbols, edges. It is correct and
nearly unreadable, because nobody explains a system by listing its imports.

The second map is the one a person draws — a handful of named boxes, arrows
with verbs on them, notes about what matters. It is authored rather than
derived: an agent reads the code and records the interpretation, and the
machine map stays underneath as evidence, so any box can be expanded back into
the files it claims.

| | Machine map | Drawn map |
|---|---|---|
| Made by | the scanner | an agent that read the code |
| Holds | files, symbols, refs, edges | components, flows, tags |
| Answers | "what imports this" | "what happens when a request arrives" |
| Trusted because | it was parsed | it cites the code, and says when that code moved |

Coverage is the honest part: files in no component are the parts nobody has
explained yet.

## One button

In the app, **Build the map** runs both passes: the deterministic scan, then
your own coding CLI, spawned in the repository, told to read the code and draw
the map over it. Progress shows the tools the agent is calling as it calls
them, and the map appears when it finishes. **Scan only** stops after the index.

It drives the CLI you already have rather than calling a model directly, so the
drawing runs under your auth, your model choice and your MCP config, and it
reaches the engine through the same tools an interactive session uses. It is
given read-only file access and the engine's tools — nothing that edits the
repository.

## Crossing between them

Every box opens onto the files underneath it: paths, line counts, symbols and
how depended-on each one is, ordered by that. Any file opens further into its
importers, imports and symbols — and says which box it belongs to, so the route
runs both ways. Flow steps open the file they name.

## The first draw is expensive; changes are not

Every box records a per-file snapshot of what it contained when it was drawn.
`map_drift` diffs that against the index and names the components whose files
edited, the files themselves, and the flows whose steps moved — so a change
means re-reading two files, not redrawing a repository.

```
map_drift  →  redraw only what it names  →  the rest still stands
```

`/map` drives both passes and knows which one it is on.

## What the map cannot see

A scan produces a map of what exists. It is silent about meaning — and worse,
silent about its own silence: a call graph with a hole in it looks exactly like
a call graph with nothing there.

Found on a real repository. A LangGraph project wires its entire control flow
with `graph.add_node("classify", classify_node)`. There is no static call from
the wiring to the node, so every node function looked like an unreachable entry
point and the flow view showed type inheritance where the workflow should have
been. The parse was correct; it simply could not know.

So the scan's job becomes finding where understanding is missing:

```
gaps  →  an agent reads the file  →  relate(evidence)  →  explored
```

`gaps` ranks what could not be resolved — files that register behaviour rather
than calling it, exported symbols nothing reaches, imports that resolved to
nothing, heavily-used files with nothing recorded about them, notes written
against code that has since changed. `coverage` reports how much of the
repository has been read since it last changed.

Recorded edges live in their own table, never merged into parsed ones: a
parsed fact and an asserted one should never be indistinguishable. **Evidence
is required** — a relation carries the line of code that justifies it and the
hash of the file it was read from, so a claim can be audited and one about
changed code is flagged rather than believed.

`/enrich` drives the loop, one subagent per gap.

## Watch

The daemon watches every registered repository and re-scans what changed, with
a 1.5s debounce so a branch switch or a formatter run costs one pass. Watched
changes trigger a scan only — re-running the project's linters on every save
would be intolerable, so the analyser pass stays explicit. `SDLC_WATCH=0`
disables it, as does the toggle on `/api/watch`.


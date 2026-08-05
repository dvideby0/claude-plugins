# Project context

Before significant product or architecture work, read:

1. [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md)
2. [`docs/CURRENT_STATE_AUDIT.md`](docs/CURRENT_STATE_AUDIT.md)
3. [`docs/BACKLOG.md`](docs/BACKLOG.md)
4. [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md) when evaluating an architectural dependency or approach

The stable boundary is that SDLC is a standalone, local-first code-intelligence application and knowledge engine. The desktop app is a first-class product; Claude and Codex plugins, skills, and MCP connections are thin clients. Keep deterministic facts, inferred relations, runtime observations, human knowledge, and LLM-derived interpretations distinguishable and evidence-backed.

The current flow implementation is a useful call-graph prototype, not yet the entry-to-terminal-effect control/data-flow model described in the vision. Preserve that distinction in product claims and implementation decisions.

# Project context

Before significant product or architecture work, read:

1. [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md)
2. [`docs/CURRENT_STATE_AUDIT.md`](docs/CURRENT_STATE_AUDIT.md)
3. [`docs/BACKLOG.md`](docs/BACKLOG.md)
4. [`docs/PROVIDER_STRATEGY.md`](docs/PROVIDER_STRATEGY.md)
5. [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md) when evaluating an architectural dependency or approach

The stable boundary is that SDLC is a standalone, local-first code-intelligence application and knowledge engine. The desktop app is a first-class product; Claude and Codex plugins, skills, and MCP connections are thin clients. Keep deterministic facts, inferred relations, runtime observations, human knowledge, and LLM-derived interpretations distinguishable and evidence-backed.

The current flow implementation is a useful call-graph prototype, not yet the entry-to-terminal-effect control/data-flow model described in the vision. Preserve that distinction in product claims and implementation decisions.

Do not implement a production language resolver, compiler-reference indexer, or universal control/data-flow engine before evaluating maintained SCIP, compiler/language-server, or Code Property Graph providers. SDLC owns provider orchestration and evidence-backed knowledge fusion, not solved language-tooling internals.

Prefer adoption over invention. Before building a substantial subsystem, actively look for mature, battle-tested software that meets the need. If it is technically strong, maintainable, securely packageable, and license-compatible, integrate it instead of rolling an SDLC-specific replacement. Record the evaluation when declining an obvious existing option.

Prefer Rust for new app-owned engine, indexing, storage, orchestration, and background-runtime code. Use TypeScript when the platform boundary makes it the sensible choice, such as Electron UI work, thin JavaScript-tool integrations, or an ecosystem SDK with no practical Rust path. Do not port working code solely to satisfy a language preference; apply this rule to new work and measured rewrites.

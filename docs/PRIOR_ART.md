# Prior art and research conclusions

Research date: 2026-08-05. The goal is not to reproduce any one product. It is to identify proven ideas, reusable standards, and places where a local desktop product can be simpler or more useful.

## Conclusions to carry into the architecture

1. **Use precise indexes and graceful fallbacks together.** Sourcegraph combines compiler-grade code navigation with search-based navigation when precise data is unavailable. Coverage should improve progressively rather than block on perfect whole-repository analysis.
2. **Represent uncertainty explicitly.** Kythe’s guidance that incomplete data is preferable to incorrect data is exactly right for dynamic dispatch, generated code, partial workspaces, and unresolved dependencies.
3. **Adopt a common intermediate graph with provenance.** CodeQL, Joern, Kythe, and Glean all normalize language-specific extraction into queryable facts or graphs. The shared representation matters more than one universal parser.
4. **Separate base facts from derived facts.** Glean’s ownership, derivation, and incrementality model is a strong pattern for invalidation. Parsed facts, resolved references, framework inferences, runtime observations, and LLM summaries should have different producers and dependencies.
5. **Make lexical and structural search excellent before betting on vectors.** Sourcegraph reports moving enterprise context away from embeddings toward search, while Aider gets high value from symbols, graph ranking, and a strict token budget. Embeddings can remain a derived candidate source for fuzzy queries.
6. **Treat graph as a model, not a database requirement.** CodeQL demonstrates that AST, control-flow, and data-flow relations can be queried from relational facts. SQLite edge tables and recursive queries are adequate for the first local product.
7. **The human application needs code and graph together.** Sourcetrail and SciTools Understand show the value of synchronized source, dependency, flow, sequence, and change-oriented views. A graph canvas alone is not the product.
8. **Measure context as a scarce resource.** Aider’s repo map is dynamically ranked to a token budget. Our query layer should optimize evidence coverage and task success at a fixed budget, not maximize retrieved text.
9. **Use supported integration mechanisms.** Both Claude and Codex now define plugin/marketplace structures and MCP configuration workflows. The app should automate those public interfaces rather than rely on ad hoc config mutation.

## Systems and products

| Prior art | What it demonstrates | What to borrow | What not to assume |
| --- | --- | --- | --- |
| [Sourcegraph code navigation](https://sourcegraph.com/docs/code-navigation), [SCIP precise navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation), and [Cody context](https://sourcegraph.com/docs/cody/core-concepts/context) | Precise cross-repository navigation combined with search fallbacks and an agent context layer | SCIP import adapters, progressive precision, search/graph composition, code-centered human UX | Rebuilding Sourcegraph’s distributed server architecture is not necessary for a local app |
| [Sourcegraph local indexing](https://sourcegraph.com/docs/cody/core-concepts/local-indexing) and [Cody FAQ](https://sourcegraph.com/docs/cody/faq) | Local keyword indexes can be fast and useful; Sourcegraph says it replaced enterprise embeddings with search for context | Search-first retrieval and an evidence-based threshold for adding embeddings | Vector search is not automatically the best foundation for code context |
| [CodeQL](https://codeql.github.com/docs/codeql-overview/about-codeql/) | Source can be extracted into relational representations containing syntax, control-flow, and data-flow relations | Relational base facts, language extractors, queryable program analysis | Bundling CodeQL’s full analysis stack or query language is not required for the first product |
| [Joern and the Code Property Graph](https://docs.joern.io/code-property-graph/) / [CPG specification](https://cpg.joern.io/) | AST, control-flow, and data-flow can coexist in a labeled attributed multigraph with overlays | A typed common graph IR and analysis overlays | A heavyweight JVM service or universal up-front CPG is not needed to validate the UX |
| [Kythe overview](https://kythe.io/docs/kythe-overview.html) and [schema](https://kythe.io/docs/schema-overview.html) | Language-independent semantic nodes, source anchors, facts, and edges support thin clients and cross-language navigation | Stable anchors, explicit edge semantics, graceful missing data, provenance-minded facts | A fully distributed indexing pipeline would be premature locally |
| [Glean](https://glean.software/) [introduction](https://glean.software/docs/introduction/), [incrementality](https://glean.software/docs/implementation/incrementality/), and [derived facts](https://glean.software/docs/derived/) | Typed facts, ownership, derived facts, schema evolution, and incremental storage can support many language indexers | Producer ownership, derivation dependencies, schema versioning, base/derived separation | A custom Datalog engine is not necessary before ordinary queries become inadequate |
| [Tree-sitter incremental parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html) | Syntax trees can be edited and reused instead of reparsing every file from scratch | Persist parse state within a running indexer and invalidate by edit range | Tree-sitter alone does not provide semantic resolution or program flow |
| [Aider repository map](https://aider.chat/docs/repomap.html) | A lightweight symbol graph, ranking, and token budget can provide strong repository context | A cheap baseline, graph ranking, dynamic budgets, signatures rather than full files | Complex retrieval should not be added until it beats this baseline |
| [Cursor secure codebase indexing](https://cursor.com/blog/secure-codebase-indexing) | Hierarchical hashes can detect exact changed files/directories and reuse unchanged index work | Merkle-style signatures and fast change localization | Cloud sharing and clone reuse have different privacy and threat models than a local-first app |
| [Continue reranking](https://docs.continue.dev/customize/model-roles/reranking) and [custom code RAG](https://docs.continue.dev/guides/custom-code-rag) | Vector candidates can be combined with refresh and reranking | Optional hybrid retrieval and reranking after a measurable lexical/graph baseline | Nearest-neighbor results should not be treated as evidence by themselves |
| [VS Code agent workspace context](https://code.visualstudio.com/docs/agents/reference/workspace-context) | Modern coding agents mix indexes with search and targeted file reads | Multiple retrieval modes exposed through one planning layer | A long list of low-level tools is not necessarily the best public interface |
| [SciTools Understand graphs](https://scitools.com/graphs) | Call, control-flow, sequence, data-flow, dependency, and comparison views serve distinct human questions | Purpose-specific visualizations and before/after comparison | One generic node-link diagram cannot replace all code navigation |
| [Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail) | A local desktop source explorer can synchronize code and graph navigation | Direct manipulation, local operation, focused neighborhoods | Its archived status is a reminder that graph exploration needs durable everyday workflows |
| [OpenGrok](https://github.com/oracle/opengrok) | Fast search, cross-reference, and history remain a valuable baseline | Identifier/text search and history-linked navigation | Semantic layers should not make exact search slower or harder |
| [Augment Context Services](https://docs.augmentcode.com/context-services/overview) | A context engine can be exposed to external agents through MCP | Treat MCP as an access surface and support cross-tool context | Vendor performance claims should be treated as positioning unless independently reproduced |

## Storage and retrieval options

### Recommended starting stack

- Use native embedded SQLite as the authoritative per-workspace store owned by the app/daemon.
- Model the graph with typed node and edge tables plus indexes and [recursive CTEs](https://sqlite.org/lang_with.html).
- Use [SQLite FTS5](https://sqlite.org/fts5.html) for identifiers, paths, documentation, memories, error strings, and semantic descriptions. Its BM25 ranking, phrase/prefix/NEAR queries, snippets, and filters provide a serious local baseline.
- Keep embeddings as optional, rebuildable derived artifacts. Evaluate [sqlite-vec](https://github.com/asg017/sqlite-vec) for small local indexes, noting its pre-1.0 status, and [LanceDB hybrid search](https://docs.lancedb.com/search/hybrid-search) if scale or vector-native storage later justifies a sidecar.
- Consider [Tantivy](https://github.com/quickwit-oss/tantivy) only if FTS5 becomes a measured bottleneck or lacks needed ranking behavior.

This is cheaper operationally than maintaining independent relational, graph, and vector services, and it preserves a straightforward local installation. The query layer can expose all three access patterns without exposing the physical store.

### External enrichers, not mandatory dependencies

SCIP indexes, CodeQL databases, language servers, compiler metadata, test coverage, and runtime traces can all enrich the common model when present. They should be adapters with explicit provenance and capability discovery. Core indexing and the desktop experience must remain useful without downloading a heavyweight external analysis suite.

The first concrete adoption is the Apache-2.0
[`@sourcegraph/scip-typescript`](https://www.npmjs.com/package/@sourcegraph/scip-typescript)
indexer plus the official Apache-2.0
[`scip` Rust bindings](https://crates.io/crates/scip). This reuses TypeScript
project/package resolution and the SCIP protocol rather than reproducing either
inside SDLC. EVAL-001 also uses the official pinned `scip test` binary and its
human-readable golden assertion format for occurrence validation; SDLC only
scores the provider-neutral relations that the upstream tool does not compare
across providers. Joern remains an optional evaluation dependency: its CPG/CFG/PDG
exports are promising, but the JVM/JDK footprint and graph translation cost
must earn their place against the golden corpus before bundling.

## Integration research

[Codex plugin documentation](https://developers.openai.com/plugins/build/plugins) describes bundles containing a `.codex-plugin/plugin.json` manifest plus skills, apps/MCP registrations, hooks, and related resources. Its marketplace workflow supports local and Git-backed sources. [Codex MCP documentation](https://developers.openai.com/codex/mcp/) describes supported CLI configuration rather than requiring direct TOML editing.

[Claude plugin discovery](https://code.claude.com/docs/en/discover-plugins), [plugin reference](https://code.claude.com/docs/en/plugins-reference), [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), and [MCP support](https://code.claude.com/docs/en/mcp) likewise provide public installation and connection workflows.

The application should keep separate connector implementations behind one product contract:

- inspect capabilities and version;
- produce a proposed installation plan;
- obtain consent for visible changes;
- invoke supported CLI/plugin mechanisms;
- verify plugin discovery, MCP connectivity, and a small health call;
- store what the app owns so update, repair, and uninstall are exact.

## How we can be better, faster, or cheaper

### Better

- Show the evidence, provenance, confidence, and freshness of every path and semantic claim.
- Unite code search, source navigation, execution paths, impact, memories, and change comparison in the desktop app.
- Let humans correct the model without mixing corrections into deterministic facts.
- Optimize the product around concrete questions and task outcomes rather than index size or graph density.

### Faster

- Produce a useful syntax/search index first, then enrich it progressively.
- Use hierarchical signatures, stable symbol identities, fact ownership, and dependency-directed invalidation.
- Import precise indexes such as SCIP when available instead of rebuilding every language resolver.
- Precompute only high-value derived relations and assemble context to a strict budget.

### Cheaper

- Bundle one native local service and one authoritative embedded database.
- Prefer FTS and graph ranking before embeddings; embed only compact semantic units that improve evals.
- Cache semantic results by model/prompt/input signature and invalidate them selectively.
- Keep plugins thin so each client update does not duplicate runtimes, storage, or analysis work.

## Research-driven decision rules

- Do not add a storage engine until a benchmark shows the current one cannot satisfy a named workload.
- Do not add embeddings until hybrid retrieval beats lexical-plus-graph baselines at the same context budget.
- Do not call a relation deterministic unless its producer and limits are recorded.
- Do not add a public MCP tool if an existing intent-oriented tool can compose the operation internally.
- Do not implement a language’s precise reference indexer before checking for a usable SCIP or compiler adapter.
- Do not build a visualization without naming the developer question it answers.

# Product direction

These documents are the durable context for product and architecture work in this repository:

- [Product vision](PRODUCT_VISION.md) — what we are building, why it is a standalone application, and the boundaries that should remain stable as the implementation changes.
- [Current-state audit](CURRENT_STATE_AUDIT.md) — what the work-in-progress implementation actually does today, where it is strong, and where it differs from the vision.
- [Prior art](PRIOR_ART.md) — systems worth learning from and the concrete lessons we should borrow or avoid.
- [Provider strategy](PROVIDER_STRATEGY.md) — the decision to import proven syntax, semantic, and program-analysis facts instead of rebuilding language tooling.
- [Backlog](BACKLOG.md) — prioritized increments with acceptance criteria and a recommended first vertical slice.
- [Evaluation](EVALUATION.md) — the measurement harness: the oracle boundary, what is measured today, and how to add a fixture.
- [Fact model](FACT_MODEL.md) — the provider-neutral fact, edge, and provenance contract every indexer writes through.

## Elsewhere in the repository

- [`../CONVENTIONS.md`](../CONVENTIONS.md) — the rules this codebase has actually been burned by. Read it before changing code.

Read the vision before making a major architectural choice. Update the audit when the implementation meaningfully changes, and keep completed backlog items as evidence rather than silently rewriting history.

# CLAUDE.md — SDLC compatibility entry point

The canonical agent instructions are [`AGENTS.md`](AGENTS.md). Read that file
before changing this repository; it owns the product rails, the build and test
commands, the repository map, and the task-to-document router. Read
[`CONVENTIONS.md`](CONVENTIONS.md) before changing code.

The load-bearing contract is repeated here only so it cannot be missed:

> Keep deterministic facts, inferred relations, runtime observations, human
> knowledge, and LLM-derived interpretations distinguishable and evidence-backed.

Do not duplicate current behaviour, versions, measurements, shipped status, or
proposals in this compatibility file. Their canonical homes are registered in
[`docs/README.md`](docs/README.md).

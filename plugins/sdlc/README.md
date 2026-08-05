# SDLC companion plugin

Commands and guidance for the standalone SDLC code-intelligence app.

The plugin is intentionally thin. Repository parsing, durable indexes,
findings, memories, reports, and model-assisted enrichment live in the local
SDLC engine installed with the desktop app. Claude Code connects to that one
long-lived engine through a small MCP bridge, so indexes stay warm and can be
shared with Codex and the desktop UI.

## Setup

1. Install and open the SDLC desktop app.
2. In **Coding harnesses**, connect Claude Code.
3. Restart Claude Code so it reloads MCP configuration.
4. Install the plugin with `/plugin install sdlc`.

Without a running engine, the commands have no SDLC tools to call and will say
so rather than installing a second copy of the engine inside the plugin.

## Commands

| Command | What it does |
|---|---|
| `/audit-quick` | Deterministic index, project linters and type checkers, secrets, dependencies, and supply-chain checks |
| `/audit` | Deterministic audit followed by model review of the highest-risk work units |
| `/audit-security` | The audit pipeline with a security-focused review lens |
| `/map` | Build or refresh the human-readable system map |
| `/enrich` | Investigate deterministic graph gaps and record evidence-backed relations |

## Persistent knowledge

The engine keeps a per-workspace store under `~/.sdlc/stores`. Repeated scans
reuse unchanged results, finding fingerprints survive line movement, accepted
risks and false positives remain sticky, and memories can be attached to code
with deterministic signatures so stale knowledge is visible after changes.

The desktop app renders the same store directly. MCP tools such as
`audit_status`, `audit_scan`, `audit_run_tools`, `audit_plan`, `audit_review`,
`audit_record_findings`, `audit_query`, `audit_suppress`, `audit_report`,
`context`, `flow`, `relations`, and `remember` expose focused slices to coding
agents without asking them to reread the repository.

The deterministic `flow` view currently follows parsed and type-resolved
references. Evidence-backed relations recorded during enrichment are a
separate overlay available through `relations`; combining both into one
computed flow is roadmap work.

See [docs/STRATEGY.md](docs/STRATEGY.md) for the analysis model. The engine
source lives in [`packages/engine`](../../packages/engine).

## License

MIT

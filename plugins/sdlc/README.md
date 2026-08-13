# SDLC companion plugin

> [SDLC](../../README.md) · [Documentation hub](../../docs/README.md)

Commands and guidance for the standalone SDLC code-intelligence app.

The plugin is intentionally thin. Repository parsing, durable indexes, findings,
memories, reports, and model-assisted enrichment live in the local SDLC engine
installed with the desktop app. Claude Code connects to that one long-lived
engine through a small MCP bridge, so indexes stay warm and can be shared with
Codex and the desktop UI.

Plugins are prompts only. They carry no server and no binaries — the engine
provides the tools, so the commands stay small and the grounding stays shared.

## Setup

1. Install and open the SDLC desktop app.
2. In **Coding harnesses**, connect Claude Code.
3. Restart Claude Code so it reloads MCP configuration.
4. Install the plugin with `/plugin install sdlc`.

Without a running engine, the commands have no SDLC tools to call and will say
so rather than installing a second copy of the engine inside the plugin.

## Commands

Every command, with what it does, is catalogued in
[Plugin commands](../../docs/reference/plugin-commands.md). The prompt files in
[`commands/`](commands/) are the commands themselves.

## Persistent knowledge

The app keeps each workspace store under `~/.sdlc/`, outside the source
repository, so repeated scans reuse unchanged results, finding fingerprints
survive line movement, accepted risks and false positives stay sticky, and
memories anchored to code come back flagged when that code changes. The layout
and the migration guarantees are in
[State and configuration](../../docs/reference/state-and-config.md).

The desktop app renders the same store. The tools that expose focused slices of
it to a coding agent are in [MCP tools](../../docs/reference/mcp-tools.md).

The deterministic `flow` view currently follows parsed and type-resolved
references. Evidence-backed relations recorded during enrichment are a separate
overlay available through `relations`; combining both into one computed flow is
roadmap work.

## Analysis model

See [docs/STRATEGY.md](docs/STRATEGY.md) for how the plugin decides what to
analyse and in what order. The engine source lives in
[`packages/engine`](../../packages/engine/README.md).

## License

MIT

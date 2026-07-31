# SDLC Plugins for Claude Code

A Claude Code plugin marketplace.

## Plugins

| Plugin | Commands | What it does |
|---|---|---|
| **repo-audit** | `/audit`, `/audit-quick`, `/audit-security` | Incremental code audit for TypeScript/JavaScript and Python. Builds a real import graph, runs your own linters, and keeps findings in a SQLite store so repeat runs update knowledge instead of starting over. Never modifies your code. |

## Install

```
/plugin marketplace add dvideby0/claude-plugins
```

```
/plugin install repo-audit
```

## Adding a plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json` with `name`, `version`
   and `description`.
2. Put components at the plugin root: `commands/`, `agents/`, `skills/`,
   `hooks/`, `.mcp.json`.
3. Add an entry to `.claude-plugin/marketplace.json`.
4. Validate before pushing:

```bash
claude plugin validate --strict plugins/<name>
```

Plugins that ship an MCP server should commit their build output so install
requires no `npm install`.

## Uninstall

```
/plugin uninstall repo-audit
```

## License

MIT

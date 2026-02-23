# SDLC Plugins for Claude Code

A collection of Claude Code plugins distributed as a plugin marketplace.

## Available Plugins

| Plugin | Command | Description |
|--------|---------|-------------|
| **repo-audit** | `/audit` | Full repository audit — auto-detects languages, runs your existing linters and tools, spawns per-module sub-agents, and generates reports in `sdlc-audit/`. Supports 15 languages, incremental mode, variant analysis, and programmatic dependency/risk scoring. Non-destructive — never modifies your code. |


## Installation

### Step 1: Add this marketplace (one-time)

In Claude Code, run:

```
/plugin marketplace add dvideby0/claude-plugins
```

### Step 2: Install individual plugins

```
/plugin install repo-audit
```

Or browse all available plugins:

```
/plugin
```

Then navigate to **Discover** to see everything in this marketplace.

## Usage

After installing a plugin, its commands are available immediately:

```
/audit                          # Run repo-audit
/repo-audit:audit               # Namespaced version (if there's a name conflict)
```

## Repo Structure

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json         ← Indexes all plugins for discovery
├── plugins/
│   ├── repo-audit/              ← Each plugin is self-contained
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   └── audit.md
│   │   ├── lang/
│   │   │   ├── typescript.md
│   │   │   ├── python.md
│   │   │   ├── go.md
│   │   │   └── ... (15 language guides)
│   │   ├── README.md
│   │   └── LICENSE
│   ├── example-plugin/          ← Your next plugin goes here
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   └── hello.md
│   │   └── ...
│   └── another-plugin/          ← And the next one here
│       └── ...
└── README.md
```

## Adding a New Plugin

1. Create a new directory under `plugins/`:

```bash
mkdir -p plugins/my-new-plugin/{.claude-plugin,commands}
```

2. Add the plugin manifest:

```json
// plugins/my-new-plugin/.claude-plugin/plugin.json
{
  "name": "my-new-plugin",
  "version": "1.0.0",
  "description": "What this plugin does"
}
```

3. Add your commands, agents, skills, or hooks at the **plugin root level** (not inside `.claude-plugin/`):

```
plugins/my-new-plugin/
├── .claude-plugin/
│   └── plugin.json       ← Only manifest goes here
├── commands/              ← Slash commands at root level
├── agents/                ← Sub-agents at root level
├── skills/                ← Skills at root level
├── hooks/                 ← Hooks at root level
└── README.md
```

4. Register it in the marketplace by adding an entry to `.claude-plugin/marketplace.json`:

```json
{
  "name": "my-new-plugin",
  "description": "What this plugin does",
  "path": "plugins/my-new-plugin"
}
```

5. Push to GitHub. Anyone who has added your marketplace can now install it.

## Uninstalling

### Remove a plugin

```
/plugin uninstall repo-audit
```

This removes the plugin and its commands from your Claude Code environment. Your project files (e.g., `sdlc-audit/` output) are not affected.

### Remove this marketplace

```
/plugin marketplace remove dvideby0/claude-plugins
```

This removes the marketplace and all plugins installed from it. You can re-add it at any time with the install command above.

## Plugin Component Types

Each plugin can include any combination of:

| Component    | Location        | Purpose                                      |
|-------------|-----------------|----------------------------------------------|
| **Commands** | `commands/`     | Slash commands (`.md` files)                 |
| **Agents**   | `agents/`       | Specialized sub-agents (`.md` files)         |
| **Skills**   | `skills/`       | Auto-discovered capabilities (`SKILL.md`)    |
| **Hooks**    | `hooks/`        | Event handlers (`hooks.json`)                |
| **MCP**      | `.mcp.json`     | External tool connections                    |
| **Scripts**   | `scripts/`     | Helper scripts for hooks/commands            |

## License

MIT

# repo-audit

Incremental code audit for TypeScript/JavaScript and Python.

It parses your code with tree-sitter to build a real import graph, runs the
linters your project already has, and keeps every finding in a SQLite store.
Run it again next week and it updates what it knows — it does not start over.

## Requires the SDLC app

This plugin is the workflow layer: commands and prompts, nothing else. The
parsing, the store and the analysis live in the SDLC engine, which the desktop
app installs and keeps running.

1. Install and open the SDLC app.
2. Under **Coding harnesses**, click **Connect** next to Claude Code.
3. Restart Claude Code.
4. `/plugin install repo-audit`

Without a running engine the commands have no tools to call, and say so.

Why it is split this way: an MCP server bundled inside a plugin gets spawned
once per session. It starts cold every time, cannot share an index between
sessions, and has to vendor every dependency as a committed binary — this
plugin used to carry 4.2 MB of wasm for exactly that reason. A long-lived
local engine fixes all three.

## Commands

| Command | What it does | Time |
|---|---|---|
| `/audit-quick` | Index, run your linters/type checkers, secret scan, dependency advisories, supply-chain and unicode checks | <1 min |
| `/audit` | Everything above, then sub-agent review of the riskiest code | 3–10 min |
| `/audit-security` | Same pipeline, security lens on the review pass | 2–5 min |

## Output

Everything lands in `sdlc-audit/` inside the repository being audited:

| Path | Contents |
|---|---|
| `audit.db` | The store — files, symbols, import edges, findings, suppressions |
| `TASKS.json` | Open findings as actionable tasks, ranked by severity |
| `reports/AUDIT.md` | Findings by severity and category, per-tool status |
| `reports/MAP.md` | Languages, most-depended-on files, risk ranking, external packages |

Your source is never modified. Undo everything with `rm -rf sdlc-audit/`.

## Repeat runs

Findings have a fingerprint derived from the rule, file, enclosing symbol and
the shape of the code — not the line number. So on the next run:

- unchanged files are not re-parsed,
- a finding that moved down the file is still the same finding,
- a finding that disappeared is marked `fixed`,
- one that came back is marked `regressed`.

To retire a finding permanently, ask Claude to suppress it (or call
`audit_suppress` with the finding id and a reason). Suppressions survive every
future run.

## Tools

The engine exposes `audit_status`, `audit_scan`, `audit_run_tools`,
`audit_plan`, `audit_context`, `audit_record_findings`, `audit_query`,
`audit_suppress` and `audit_export`. You can drive them directly — ask Claude
things like "which files import `db.ts`?" or "show open security findings".

## What the deterministic pass covers

Your own linters and type checkers, plus checks that run without any external
tool: secrets, dependency advisories (OSV), import cycles, unicode smuggling
(bidi and zero-width characters), and supply-chain risk — install hooks that
execute remote code, workflows that interpolate attacker-controlled values or
check out untrusted refs with secrets, and agent config (`.claude/`,
`.mcp.json`, `.vscode/tasks.json`) that runs commands when the repo is opened.

See [docs/STRATEGY.md](docs/STRATEGY.md) for how it works. The engine itself
lives in [`packages/engine`](../../packages/engine).

## License

MIT

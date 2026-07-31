---
description: Fast deterministic scan — index the repo, run your linters and type checkers, secret scan and dependency advisories. No sub-agents.
allowed-tools: Read, mcp__plugin_repo-audit_repo-audit__audit_status, mcp__plugin_repo-audit_repo-audit__audit_scan, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_query, mcp__plugin_repo-audit_repo-audit__audit_export
---

# Quick audit

No LLM review — deterministic tools only. Typically under a minute.

1. Call `audit_scan`.
2. Call `audit_run_tools`.
3. Call `audit_export`.

Then present:

- Open findings by severity, and the change since the last run (new, reopened,
  closed).
- Per-tool status exactly as returned. If a tool was skipped, say why — never
  present a skipped tool as a passing one.
- The top 5 files from `audit_query` with `kind: "hotspots"`.

Close by noting that `/audit` adds sub-agent review of the riskiest code.

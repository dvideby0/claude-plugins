---
description: Security-focused audit — secrets, dependency advisories, and sub-agent review of the riskiest code through a security lens
allowed-tools: Task, Read, Grep, Glob, mcp__sdlc__audit_status, mcp__sdlc__audit_scan, mcp__sdlc__audit_run_tools, mcp__sdlc__audit_plan, mcp__sdlc__audit_context, mcp__sdlc__audit_record_findings, mcp__sdlc__audit_query, mcp__sdlc__audit_report
---

# Security audit

1. Call `audit_scan`.
2. Call `audit_run_tools` — this covers secret scanning and OSV dependency
   advisories alongside the project's linters.
3. Call `audit_plan` with `maxUnits: 10`.
4. For each unit, call `audit_context` with `lens: "security"`, then spawn a
   Task agent (`subagent_type: general-purpose`) with the returned
   `prompt`. Run up to 5 concurrently.
5. Call `audit_report`.

Present findings in `category: security` first, then dependency advisories.
For every secret finding, state plainly that the credential must be rotated —
removing it from source is not sufficient.

Use `audit_query` with `kind: "findings"` and `arg: "security"` for the list.

---
description: Fast deterministic-only scan — runs linters, type checkers, dependency audits, and pattern pre-scans without spawning LLM sub-agents. Results in 30-60 seconds.
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_discover, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_assemble_outputs, mcp__plugin_repo-audit_repo-audit__audit_get_status
---

# Quick Audit Scan

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY. ALL output goes inside `sdlc-audit/` — nothing else is touched.

---

## Step 1: Explain to User

> **What `/audit-quick` does:**
>
> A fast scan using only deterministic tools — no LLM sub-agents.
> Runs in 30-60 seconds and produces a single summary report.
>
> **Tools it runs** (if available): linters, type checkers, dependency audits,
> code metrics, git history, and pattern pre-scans.
>
> **Output:** `sdlc-audit/reports/QUICK_SCAN.md`
>
> Does NOT modify any of your files. `rm -rf sdlc-audit/` undoes everything.

Ask the user to confirm before proceeding.

## Step 2: Discovery

Call `audit_discover`. If `detection.json` already exists, the tool reuses it.

Report: **[1/3] Discovery complete** — [X] languages, [Y] frameworks, [Z] directories

## Step 3: Pre-Analysis Tools

Call `audit_run_tools`. This runs all available deterministic tools in parallel.

Report: **[2/3] Pre-analysis complete** — summarize tool results

## Step 4: Generate Quick Scan Report

Call `audit_assemble_outputs` with `auditType: "quick"`.

Then write `sdlc-audit/reports/QUICK_SCAN.md` by reading the tool output files
in `sdlc-audit/tool-output/` and `sdlc-audit/prescan/`. Include sections for:

- **Overview**: languages, frameworks, file counts
- **Linter Results**: error/warning counts, top 10 violations
- **Type Checker Results**: error counts, top 10 type errors
- **Dependency Vulnerabilities**: CVEs by severity
- **Pattern Pre-Scan**: critical pattern matches (secrets, eval, injection)
- **Code Metrics**: lines of code, largest files
- **Git Activity**: hotspot files, bus factor
- **Summary**: total critical issues, warnings, missing tools

Only include sections where data was actually collected. Never fabricate findings.

Report: **[3/3] Quick scan complete**

Present summary and suggest `/audit` for deeper analysis if significant issues found.

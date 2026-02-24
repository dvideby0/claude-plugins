---
description: Security-focused audit — scans for secrets, dependency vulnerabilities, injection patterns, auth issues, and OWASP Top 10 concerns. Runs in 2-3 minutes.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_discover, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_plan_analysis, mcp__plugin_repo-audit_repo-audit__audit_get_module_context, mcp__plugin_repo-audit_repo-audit__audit_get_specialist_context, mcp__plugin_repo-audit_repo-audit__audit_assemble_outputs, mcp__plugin_repo-audit_repo-audit__audit_get_status
---

# Security Audit

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY. ALL output goes inside `sdlc-audit/` — nothing else is touched.

---

## Step 1: Explain to User

> **What `/audit-security` does:**
>
> A focused security scan covering:
> - Hardcoded secrets and API keys
> - Dependency vulnerabilities (CVEs)
> - Injection patterns (SQL, XSS, command injection)
> - Authentication and authorization issues
> - OWASP Top 10 concerns
>
> **Estimated time:** 2-3 minutes
> **Output:** `sdlc-audit/reports/SECURITY_REPORT.md`
>
> Does NOT modify any of your files.

Ask the user to confirm before proceeding.

## Step 2: Discovery

Call `audit_discover` (reuses cached detection.json if available).

Report: **[1/5] Discovery complete**

## Step 3: Security-Focused Pre-Analysis

Call `audit_run_tools` with `tools: ["secrets-scan", "dep-audit"]`. This runs
secrets scanning and dependency vulnerability audits.

Report: **[2/5] Deterministic security scans complete**

## Step 4: Module Analysis (Security-Focused)

Call `audit_plan_analysis`. For each assignment, call `audit_get_module_context`
and spawn a Task agent with the returned `taskPrompt` plus security focus:

Add to each agent's prompt:
> Focus primarily on security concerns — injection patterns, auth issues,
> input validation, secrets exposure. Non-security findings are secondary.

Run agents in parallel batches.

Report: **[3/5] Module security analysis complete**

## Step 5: Security Specialist

Call `audit_get_specialist_context` with `domain: "security"`. Spawn the
security-specialist agent with the returned `taskPrompt`.

The specialist writes to `sdlc-audit/specialists/security-findings.json`.

Report: **[4/5] Security specialist analysis complete**

## Step 6: Generate Security Report

Call `audit_assemble_outputs` with `auditType: "security"`.

Report: **[5/5] Security report complete**

Present summary: critical/warning/info counts, top findings.
Suggest running `/audit` for the full codebase analysis.

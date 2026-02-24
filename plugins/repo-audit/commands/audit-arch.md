---
description: Architecture review — detects god modules, layering violations, coupling issues, and computes risk scores to identify which modules need attention first. Runs in 3-5 minutes.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_discover, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_plan_analysis, mcp__plugin_repo-audit_repo-audit__audit_get_module_context, mcp__plugin_repo-audit_repo-audit__audit_validate_modules, mcp__plugin_repo-audit_repo-audit__audit_plan_specialists, mcp__plugin_repo-audit_repo-audit__audit_get_specialist_context, mcp__plugin_repo-audit_repo-audit__audit_build_graphs, mcp__plugin_repo-audit_repo-audit__audit_assemble_outputs, mcp__plugin_repo-audit_repo-audit__audit_get_status
---

# Architecture Audit

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY. ALL output goes inside `sdlc-audit/` — nothing else is touched.

---

## Step 1: Explain to User

> **What `/audit-arch` does:**
>
> Analyzes your project's architecture:
> - God module detection (too complex, too many dependents)
> - Layering violations (UI importing from DB, etc.)
> - Coupling analysis with risk scoring
> - Bus factor per module (git contributor concentration)
> - Module responsibility analysis
> - Complexity specialist analysis
>
> **Estimated time:** 3-5 minutes
> **Output:** `sdlc-audit/reports/ARCHITECTURE_REVIEW.md`
>
> Does NOT modify any of your files.

Ask the user to confirm before proceeding.

## Step 2: Discovery + Pre-Analysis

Call `audit_discover` (reuses cached detection.json if available).
Call `audit_run_tools` for metrics and git history data.

Report: **[1/4] Discovery and metrics complete**

## Step 3: Module Analysis

If `sdlc-audit/modules/*.json` already exist from a previous audit, skip this step.

Otherwise, call `audit_plan_analysis`. For each assignment, call
`audit_get_module_context` and spawn a Task agent. Architecture review requires
full module analysis to understand purpose, complexity, and internal structure.

Run agents in parallel batches.

Report: **[2/4] Module analysis complete** — [N] modules analyzed

## Step 4: Architecture Analysis

Call `audit_build_graphs`. This builds the dependency graph, computes risk scores,
runs variant analysis, and returns cross-module agent prompts.

Spawn the **Architecture agent** from the returned cross-module prompts. It reads
module JSONs, dependency data, and risk scores to identify god modules, layering
violations, and coupling issues.

Call `audit_plan_specialists`. If the complexity specialist meets its threshold,
call `audit_get_specialist_context` for `domain: "complexity"` and spawn the
complexity-specialist agent.

Report: **[3/4] Architecture analysis complete**

## Step 5: Generate Architecture Report

Call `audit_assemble_outputs` with `auditType: "arch"`.

Report: **[4/4] Architecture report complete**

Present the risk dashboard summary to the user.

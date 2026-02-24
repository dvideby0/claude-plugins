---
description: Dependency analysis — builds module dependency graph, detects circular dependencies, classifies hub/orphan modules, and scans for external dependency vulnerabilities. Runs in 1-2 minutes.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_discover, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_plan_analysis, mcp__plugin_repo-audit_repo-audit__audit_get_module_context, mcp__plugin_repo-audit_repo-audit__audit_build_graphs, mcp__plugin_repo-audit_repo-audit__audit_assemble_outputs, mcp__plugin_repo-audit_repo-audit__audit_get_status
---

# Dependency Audit

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY. ALL output goes inside `sdlc-audit/` — nothing else is touched.

---

## Step 1: Explain to User

> **What `/audit-deps` does:**
>
> Analyzes your project's dependency structure:
> - Internal module dependency graph (who imports what)
> - Circular dependency detection
> - Hub modules (too many dependents) and orphans (unused)
> - External package vulnerability scan
> - Risk scoring per module
>
> **Estimated time:** 1-2 minutes
> **Output:** `sdlc-audit/reports/DEPENDENCY_GRAPH.md`
>
> Does NOT modify any of your files.

Ask the user to confirm before proceeding.

## Step 2: Discovery

Call `audit_discover` (reuses cached detection.json if available).

Report: **[1/4] Discovery complete**

## Step 3: Module Analysis (Dependency-Focused)

If `sdlc-audit/modules/*.json` already exist from a previous audit, skip to Step 4.

Otherwise, call `audit_plan_analysis`. For each assignment, call
`audit_get_module_context` and spawn a Task agent focused on dependency extraction:

Add to each agent's prompt:
> Focus on extracting import/export relationships and dependency information.
> Full code quality analysis is secondary.

Run agents in parallel batches.

Report: **[2/4] Module dependencies extracted**

## Step 4: Dependency Graph + Risk Analysis

Call `audit_build_graphs`. This runs the dependency graph builder, risk scorer,
and variant analysis. It also returns cross-module agent prompts.

Spawn the Architecture agent (from the returned cross-module prompts) to analyze
the dependency graph for cycles, hubs, orphans, and coupling issues.

Report: **[3/4] Dependency analysis complete**

## Step 5: Generate Dependency Report

Call `audit_assemble_outputs` with `auditType: "deps"`.

Report: **[4/4] Dependency report complete**

Present summary: module count, cycle count, hub count, CVE count.

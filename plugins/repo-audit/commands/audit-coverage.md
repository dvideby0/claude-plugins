---
description: Test coverage analysis — assesses per-module test coverage, identifies critical untested paths, and evaluates test quality. Runs in 2-3 minutes.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_discover, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_plan_analysis, mcp__plugin_repo-audit_repo-audit__audit_get_module_context, mcp__plugin_repo-audit_repo-audit__audit_plan_specialists, mcp__plugin_repo-audit_repo-audit__audit_get_specialist_context, mcp__plugin_repo-audit_repo-audit__audit_build_graphs, mcp__plugin_repo-audit_repo-audit__audit_assemble_outputs, mcp__plugin_repo-audit_repo-audit__audit_get_status
---

# Test Coverage Audit

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY. ALL output goes inside `sdlc-audit/` — nothing else is touched.

---

## Step 1: Explain to User

> **What `/audit-coverage` does:**
>
> Analyzes test coverage across your project:
> - Per-module coverage assessment (full / partial / none)
> - Critical untested paths (high-risk code with no tests)
> - Test quality analysis (shallow tests, missing edge cases)
> - Testing pattern gaps and recommendations
> - Test quality specialist analysis
>
> **Estimated time:** 2-3 minutes
> **Output:** `sdlc-audit/reports/TEST_COVERAGE_MAP.md`
>
> Does NOT modify any of your files.

Ask the user to confirm before proceeding.

## Step 2: Discovery + Pre-Analysis

Call `audit_discover` (reuses cached detection.json if available).
Call `audit_run_tools` for pre-analysis data.

Report: **[1/4] Discovery complete**

## Step 3: Module Analysis

If `sdlc-audit/modules/*.json` already exist from a previous audit, skip this step.

Otherwise, call `audit_plan_analysis`. For each assignment, call
`audit_get_module_context` and spawn a Task agent. Coverage analysis requires
the `test_coverage`, `has_tests`, and issue data from each module.

Run agents in parallel batches.

Report: **[2/4] Module analysis complete**

## Step 4: Coverage Analysis

Call `audit_build_graphs` to compute risk scores and get cross-module prompts.

Spawn the **Test & Documentation Coverage agent** from the returned cross-module
prompts. It reads all module JSONs, risk scores, and coverage data.

Call `audit_plan_specialists`. If the test_quality specialist meets its threshold,
call `audit_get_specialist_context` for `domain: "test_quality"` and spawn the
test-quality-specialist agent.

Report: **[3/4] Coverage analysis complete**

## Step 5: Generate Coverage Report

Call `audit_assemble_outputs` with `auditType: "coverage"`.

Report: **[4/4] Coverage report complete**

Present summary: modules with full/partial/no coverage, top 3 critical gaps.

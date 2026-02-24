---
description: Convention discovery — identifies naming patterns, error handling styles, testing approaches, and inconsistencies across your codebase. Generates a proposed CLAUDE.md. Runs in 2-3 minutes.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_discover, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_plan_analysis, mcp__plugin_repo-audit_repo-audit__audit_get_module_context, mcp__plugin_repo-audit_repo-audit__audit_build_graphs, mcp__plugin_repo-audit_repo-audit__audit_assemble_outputs, mcp__plugin_repo-audit_repo-audit__audit_get_status
---

# Patterns Audit

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY. ALL output goes inside `sdlc-audit/` — nothing else is touched.

---

## Step 1: Explain to User

> **What `/audit-patterns` does:**
>
> Discovers conventions and patterns across your codebase:
> - Naming conventions (per language, per module)
> - Error handling patterns and inconsistencies
> - Testing patterns and frameworks
> - Import/export style consistency
> - Logging, config, and state management approaches
> - Generates a proposed CLAUDE.md with discovered conventions
>
> **Estimated time:** 2-3 minutes
> **Output:** `sdlc-audit/reports/PATTERNS.md` + `sdlc-audit/staged/CLAUDE.md`
>
> Does NOT modify any of your files.

Ask the user to confirm before proceeding.

## Step 2: Discovery

Call `audit_discover` (reuses cached detection.json if available).

Report: **[1/4] Discovery complete**

## Step 3: Module Analysis

If `sdlc-audit/modules/*.json` already exist from a previous audit, skip this step.

Otherwise, call `audit_run_tools` for pre-analysis data, then call
`audit_plan_analysis`. For each assignment, call `audit_get_module_context`
and spawn a Task agent. Pattern discovery requires the `patterns` field in
each module's analysis.

Run agents in parallel batches.

Report: **[2/4] Module analysis complete**

## Step 4: Pattern Analysis

Call `audit_build_graphs` to get cross-module agent prompts.

Spawn two agents in parallel:
- **Inconsistencies agent** — from the returned cross-module prompts.
  Writes `sdlc-audit/data/cross-module-inconsistencies.json`.
- **Patterns + CLAUDE.md agent** — reads all module JSONs and inconsistency
  data, then writes `sdlc-audit/reports/PATTERNS.md` and
  `sdlc-audit/staged/CLAUDE.md`.

Report: **[3/4] Pattern analysis complete**

## Step 5: Assemble and Present

Call `audit_assemble_outputs` with `auditType: "patterns"` and
`synthesisPrompts: true`. Use the returned synthesis prompts to generate
PATTERNS.md and staged CLAUDE.md if not already created by the patterns agent.

Report: **[4/4] Complete**

> **Patterns audit complete!**
>
> - `sdlc-audit/reports/PATTERNS.md` — [N] patterns documented, [M] inconsistencies
> - `sdlc-audit/staged/CLAUDE.md` — Proposed conventions for your CLAUDE.md
>
> Review `sdlc-audit/staged/CLAUDE.md` and copy desired sections into your
> project's CLAUDE.md.

---
description: Full repository audit — auto-detects languages and frameworks, runs your tools, spawns specialist agents, generates audit report and task list
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_get_status, mcp__plugin_repo-audit_repo-audit__audit_discover, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_plan_analysis, mcp__plugin_repo-audit_repo-audit__audit_get_module_context, mcp__plugin_repo-audit_repo-audit__audit_validate_modules, mcp__plugin_repo-audit_repo-audit__audit_plan_specialists, mcp__plugin_repo-audit_repo-audit__audit_get_specialist_context, mcp__plugin_repo-audit_repo-audit__audit_build_graphs, mcp__plugin_repo-audit_repo-audit__audit_assemble_outputs
---

# Full Repository Audit

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY with respect to the user's repository.

- Do NOT modify any existing file in the repository
- Do NOT modify CLAUDE.md — stage proposed updates in `sdlc-audit/staged/CLAUDE.md`
- ALL output goes inside `sdlc-audit/` — nothing else is touched
- Cleanup is `rm -rf sdlc-audit/`

---

## Step 0: Explain and Confirm

Present to the user:

> **What `/audit` does:**
> Scans your entire repository and produces reports analyzing code quality,
> architecture, patterns, dependencies, tech debt, and test coverage.
>
> **Creates:** `sdlc-audit/` directory with all analysis reports, data, and a TASKS.json
> **Does NOT:** modify source code, commit to git, or install packages
> **Undo:** `rm -rf sdlc-audit/`

Ask the user to confirm. Call `audit_get_status` to check for a previous audit.
If a previous audit exists, offer **incremental** (re-analyze changed modules only),
**full** (start fresh), or **cancel**.

---

## Step 1: Discovery

Call `audit_discover` with `projectRoot` set to the repo root. If incremental mode
was selected, pass `incremental: true`.

Report: **[1/8] Discovery complete** — [N] languages, [M] frameworks, [K] directories

Present the audit plan (directory count, estimated sub-agents, tools to run) and
ask the user to confirm before proceeding.

## Step 2: Pre-Analysis Tools

Call `audit_run_tools`. This runs linters, type checkers, dependency audits,
pattern pre-scans, and skeleton extraction in parallel.

Report: **[2/8] Pre-analysis complete** — summarize tool results

## Step 3: Plan Module Analysis

Call `audit_plan_analysis`. This reads detection.json, applies batching rules,
and returns the assignment plan.

Report: **[3/8] Planned [N] module assignments**

## Step 4: Deep Analysis (Module Sub-Agents)

For each assignment from Step 3, call `audit_get_module_context` with the
assignment ID to get a complete task prompt, then spawn a Task agent:

- `subagent_type`: `general-purpose`
- `prompt`: the `taskPrompt` from `audit_get_module_context`
- Run in parallel batches (up to 5 concurrent agents)

Each agent writes its findings to `sdlc-audit/modules/<module>.json`.

Report: **[4/8] Deep analysis complete** — [N] modules analyzed

## Step 5: Validate Modules

Call `audit_validate_modules`. If any modules fail validation, call
`audit_get_module_context` for each failed module and re-spawn once.

Report: **[5/8] Validation complete** — [passed]/[total] modules valid

## Step 6: Specialist Agents

Call `audit_plan_specialists`. For each specialist that meets its threshold,
call `audit_get_specialist_context` for that domain, then spawn the specialist
agent using the Task tool:

- `subagent_type`: the agent name (e.g., `error-handling-specialist`)
- `prompt`: the `taskPrompt` from `audit_get_specialist_context`
- Run specialists in parallel

Each specialist writes findings to `sdlc-audit/specialists/<domain>-findings.json`.

Report: **[6/8] Specialist analysis complete** — [N] specialists ran

## Step 7: Cross-Module Analysis + Graphs

Call `audit_build_graphs`. This runs dependency graph, risk scoring, and variant
analysis scripts. It returns cross-module agent prompts.

Spawn cross-module agents in parallel using the returned prompts:
- DRY Violations agent → `sdlc-audit/data/cross-module-dry.json`
- Inconsistencies agent → `sdlc-audit/data/cross-module-inconsistencies.json`
- Architecture agent → `sdlc-audit/data/cross-module-architecture.json`
- Coverage agent → `sdlc-audit/data/cross-module-coverage.json`

Report: **[7/8] Cross-module analysis complete**

## Step 8: Assemble Outputs

Call `audit_assemble_outputs` with `auditType: "full"` and
`synthesisPrompts: true`. This generates all reports and TASKS.json.

If synthesis prompts are returned, spawn Task agents for:
- **PATTERNS.md synthesis** — using the patterns prompt
- **CLAUDE.md synthesis** — using the CLAUDE.md prompt

Report: **[8/8] Reports generated**

---

## Final Summary

Present the summary dashboard:

> **Audit complete!** Results in `sdlc-audit/`.
>
> | Report | Findings |
> |--------|----------|
> | AUDIT_REPORT.md | [X] critical, [Y] warning, [Z] info |
> | TASKS.json | [N] actionable tasks |
> | TECH_DEBT.md | [N] items prioritized |
> | PROJECT_MAP.md | [N] modules mapped |
> | PATTERNS.md | [N] conventions documented |
> | DEPENDENCY_GRAPH.md | [N] modules, [C] cycles |
> | TEST_COVERAGE_MAP.md | [N]% modules with tests |
>
> **Start with:** `sdlc-audit/AUDIT_REPORT.md` and `sdlc-audit/TASKS.json`

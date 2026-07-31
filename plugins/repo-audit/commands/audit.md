---
description: Full repository audit — index, run your tools, review the riskiest code with sub-agents, export reports and TASKS.json
allowed-tools: Task, Read, Grep, Glob, AskUserQuestion, mcp__plugin_repo-audit_repo-audit__audit_status, mcp__plugin_repo-audit_repo-audit__audit_scan, mcp__plugin_repo-audit_repo-audit__audit_run_tools, mcp__plugin_repo-audit_repo-audit__audit_plan, mcp__plugin_repo-audit_repo-audit__audit_context, mcp__plugin_repo-audit_repo-audit__audit_record_findings, mcp__plugin_repo-audit_repo-audit__audit_query, mcp__plugin_repo-audit_repo-audit__audit_export
---

# Full audit

Read-only with respect to the user's code. Everything is written under
`sdlc-audit/`. Undo is `rm -rf sdlc-audit/`.

## 1. Check state

Call `audit_status`. If a previous audit exists, tell the user what is already
known (indexed files, open findings, last run) and that this run will update it
incrementally rather than start over. Confirm before proceeding.

## 2. Index

Call `audit_scan`. Report files indexed, symbols, edges, and how many files
changed since the last run.

## 3. Deterministic analysis

Call `audit_run_tools`. Report per-tool status verbatim — a skipped tool is
skipped, never "clean". Report created / reopened / closed finding counts.

## 4. Plan

Call `audit_plan`. It returns risk-ranked review units. Show the user the top
units with their `reason` and ask to confirm the scope.

## 5. Review

For each unit, call `audit_context` with its `unitId`, then spawn a Task agent:

- `subagent_type`: `general-purpose`
- `prompt`: the returned `taskPrompt`

Run up to 5 concurrently. Each agent records its own findings via
`audit_record_findings` and may pull more context with `audit_query`. Do not
re-record findings yourself.

## 6. Export

Call `audit_export`. Report the file paths and the open-findings breakdown.

## Summary

Present: open findings by severity, what changed since the last run (new,
reopened, closed), the top 5 risk files, and where the reports are. Point the
user at `sdlc-audit/TASKS.json` for the actionable list.

---
description: Full repository audit — auto-detects languages and frameworks, spawns sub-agents per module, generates audit reports, dependency graphs, and staged CLAUDE.md proposals
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion
---

# Full Repository Audit

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY with respect to the user's repository.

- Do NOT modify any existing file in the repository
- Do NOT modify CLAUDE.md — stage proposed updates in `sdlc-audit/staged/CLAUDE.md`
- Do NOT modify source code, config files, or documentation
- Do NOT create files outside of the `sdlc-audit/` directory
- ALL output goes inside `sdlc-audit/` — nothing else is touched
- The ONLY directory this audit creates or modifies is `sdlc-audit/`

If you need to suggest changes to any existing file, describe the suggestion
in the appropriate report (AUDIT_REPORT.md or TECH_DEBT.md) and/or stage
a proposed version in `sdlc-audit/staged/`.

---

Available language guides in this plugin:
!`ls ${CLAUDE_PLUGIN_ROOT}/lang/`

Perform a comprehensive, language-aware codebase audit using a multi-phase
agent architecture. This audit covers EVERY directory and file type in the
repository — source code, configuration, infrastructure, tests, scripts,
and documentation.

---

## Step 0-intro: Explain the Audit to the User

Before running any commands, present this to the user:

---

**What `/audit` does:**

This audit scans your entire repository and produces a set of reports analyzing
code quality, architecture, patterns, dependencies, tech debt, and test coverage.

**What it creates:**
- An `sdlc-audit/` directory at your project root containing all analysis reports and data

**What it does NOT do:**
- Does NOT modify, reformat, or fix any of your source code
- Does NOT delete any files or modify your CLAUDE.md
- Does NOT commit anything to git or install any packages
- Completely non-destructive — `rm -rf sdlc-audit/` undoes everything

**How it works:**
1. **Discovery** (~30 seconds) — Scans directory structure, detects languages and frameworks
2. **Pre-analysis** (~1-2 minutes) — Runs linters, type checkers, dependency audits
3. **Deep analysis** (~3-10 minutes) — Spawns sub-agents to analyze each module in parallel
4. **Cross-reference** (~1-2 minutes) — Correlates findings across modules
5. **Reports** (~1 minute) — Generates actionable markdown reports

---

Ask the user to confirm before proceeding: "Ready to start the audit?"

If `sdlc-audit/` already exists from a previous audit, check for
`sdlc-audit/data/.audit-meta.json`. If it exists, offer incremental mode:

> I found a previous audit from [date].
>
> **Options:**
> 1. **Incremental audit** — Only re-analyze files changed since the last audit
>    and their dependents. Faster for follow-up audits.
> 2. **Full audit** — Start fresh, overwriting all previous results.
> 3. **Cancel** — Keep the existing audit as-is.

If `.audit-meta.json` doesn't exist (old format), just ask: "Overwrite or cancel?"

Only proceed once the user confirms.

### Incremental Mode Logic

If the user selects incremental mode:

1. Read `sdlc-audit/data/.audit-meta.json` to get the previous audit's git SHA or timestamp.

2. Find changed files since the last audit:
```bash
# If git is available and previous SHA is known:
git diff --name-only <previous_sha> HEAD 2>/dev/null

# Fallback: files modified since the last audit timestamp
find . -type f -newer sdlc-audit/data/.audit-meta.json \
  -not -path '*/node_modules/*' -not -path '*/.git/*' \
  -not -path '*/vendor/*' -not -path '*/dist/*' \
  -not -path '*/build/*' -not -path '*/.venv/*' \
  -not -path '*/target/*' -not -path '*/obj/*' \
  -not -path '*/sdlc-audit/*'
```

3. Map changed files to their module directories using `sdlc-audit/data/detection.json`'s
   `all_directories` map.

4. Identify the blast radius — modules that need re-analysis:
   - **Changed modules**: directories containing changed files
   - **Dependent modules**: if `sdlc-audit/data/dependency-data.json` exists, include
     any module that depends on a changed module (using `depended_on_by` from the graph)

5. Check for structural changes:
   - New directories not in the previous `detection.json` -> force full audit
   - Deleted directories -> force full audit
   - If > 50% of modules are affected -> suggest full audit instead

6. Store the incremental plan in memory:
   - `modules_to_reanalyze`: list of module directories to re-scan
   - `modules_to_reuse`: list of module directories whose existing JSONs are kept
   - Report to user: "Re-analyzing [N] modules ([list]). Reusing [M] unchanged modules."

7. **Phase 0 still runs fully** (discovery may find new files/languages)
8. **Phase 0.5 still runs fully** (linters/tools should check all files)
9. **Phase 1 only spawns sub-agents for `modules_to_reanalyze`** — existing JSONs
   in `sdlc-audit/modules/` are preserved for unchanged modules
10. **Phase 1.5, 2, 3 always run fully** — cross-module analysis and reports must
    reflect the complete picture

If incremental mode is NOT selected (full audit), delete all contents of
`sdlc-audit/` before starting.

---

## Phase Execution

Each phase's detailed instructions are in separate files. Read each phase
file and execute its instructions before moving to the next phase.

### Phase 0: Discovery

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/discovery.md`
and execute all steps.

**After Phase 0 completes**, report progress to the user:

> **[1/6] Discovery complete.** Found:
> - [X] languages: [list them]
> - [Y] frameworks: [list them]
> - [Z] directories to analyze
>
> Starting pre-analysis...

### Audit Estimation

After Phase 0 completes, calculate and present an estimate before proceeding.
Read `sdlc-audit/data/detection.json` and compute:

- **Total files and directories** from `total_source_files` and `total_directories`
- **Sub-agent count** from the number of entries in `all_directories` (apply
  batching rules: < 5 files batch together, 20+ files split)
- **Tools to run** from `tooling` section (which linters, type checkers, audit tools)

Present this to the user:

> **Audit plan:**
> - Repository: [N] files across [M] directories
> - Languages: [list with percentages if available]
> - Estimated sub-agents: ~[count]
> - Pre-analysis tools: [list of tools that will run]
> - Estimated time: [calculate based on size]
>
> Proceed?

**Size-based time estimates:**
- Small (< 100 files, < 15 directories): ~3-5 minutes
- Medium (100-500 files, 15-40 directories): ~5-10 minutes
- Large (500+ files, 40+ directories): ~10-15 minutes

**Size warnings:**
- If 100+ directories or 1000+ files: warn that this is a large repo and
  suggest `/audit-quick` as a faster alternative for an initial scan
- If any single directory has 50+ files: note that its sub-agent may need
  to sample rather than read every file exhaustively

Only proceed after user confirms.

### Phase 0.5: Pre-Analysis

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/pre-analysis.md`
and execute all steps.

**After Phase 0.5 completes**, report progress:

> **[2/6] Pre-analysis complete:**
> - Code metrics: [collected / skipped]
> - Git history: [collected / skipped]
> - Linters: [list tools run and summary counts]
> - Type checking: [list tools run and summary counts]
> - Dependency audit: [list tools run and vulnerability counts]
> - Pattern pre-scan: [N] pattern matches across [M] files
> - Code skeletons: extracted for [N] files
>
> Spawning [N] sub-agents for deep analysis...

### Phase 1: Deep Analysis

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/deep-analysis.md`
and execute all steps.

**During Phase 1**, report progress as each sub-agent completes:

> **[3/6] Deep analysis** — [completed]/[total] modules ([list recently completed])

**After Phase 1 completes**:

> **[3/6] Deep analysis complete.** All [N] sub-agents finished.
> - Analyzed [X] files across [Y] directories
> - Found [Z] issues ([A] critical, [B] warning, [C] info)
> - Confidence breakdown: [D] definite, [E] high, [F] medium, [G] low
>
> Running variant analysis...

### Phase 1.5: Variant Analysis

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/variant-analysis.md`
and execute all steps.

**After Phase 1.5 completes**:

> **[4/6] Variant analysis complete:**
> - [N] systemic patterns found (same issue across 3+ modules)
> - [M] new variant instances discovered
>
> Running cross-module analysis...

### Phase 2: Cross-Module Analysis

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/cross-module.md`
and execute all steps.

**After Phase 2 completes**:

> **[5/6] Cross-module analysis complete.** Found:
> - [N] cross-module issues (DRY violations, inconsistencies, architecture)
> - Dependency cycles: [count or "none"]
> - Highest-risk modules: [top 3 by risk score]
>
> Generating reports...

### Phase 3: Report Generation

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/report-generation.md`
and execute all steps.

**After Phase 3 completes**:

> **[6/6] Reports complete.**

### Phase 4: Review and Apply

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/review-and-apply.md`
and present the final summary.

**Final summary dashboard:**

> **Audit complete!** Results in `sdlc-audit/`.
>
> | Report | Findings |
> |--------|----------|
> | AUDIT_REPORT.md | [X] critical, [Y] warning, [Z] info |
> | TECH_DEBT.md | [N] items prioritized |
> | PROJECT_MAP.md | [N] modules mapped |
> | PATTERNS.md | [N] conventions documented |
> | DEPENDENCY_GRAPH.md | [N] modules, [C] cycles |
> | TEST_COVERAGE_MAP.md | [N]% modules with tests |
>
> **High-confidence findings:** [count] definite + high confidence issues
> **Start with:** `sdlc-audit/reports/AUDIT_REPORT.md`

---

## Execution Notes

- **Output isolation**: ALL files are written inside `sdlc-audit/`. No exceptions.
  No existing repository files are modified. Cleanup is `rm -rf sdlc-audit/`.
- **Monorepo**: Treat each package/service as independent audit unit, then cross-analyze.
- **Generated/vendored code**: Only things in the SKIP category are excluded. Everything else is analyzed.
- **Valid JSON**: All `sdlc-audit/modules/*.json` must be parseable JSON.
- **Completeness verification**: After Phase 1, verify that every directory from the `all_directories` map has a corresponding JSON output file. If any are missing, spawn additional sub-agents to cover them.
- **Large repos (500+ files)**: Increase sub-agent cap to 30. If still insufficient, note which modules were sampled vs exhaustively analyzed.
- **Files the sub-agent can't read** (binary, images, compiled): Note them in the JSON output as `"skipped_binary": ["path/to/file"]` but don't error.
- **Previous audit**: If `sdlc-audit/` already exists, note this to the user and ask whether to overwrite or preserve the previous results.

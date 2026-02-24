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

### Version and Configuration Checks

When incremental mode is selected, after reading `.audit-meta.json`, check for staleness:

1. Read the current plugin version from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`
2. Compare with `plugin_version` in `.audit-meta.json`
3. If versions differ (or `plugin_version` is null from an older audit), warn the user:
   > "The repo-audit plugin has been updated since the last audit
   > (v[old] → v[new]). Analysis rules may have changed.
   > **Recommendation:** Run a full audit to apply the latest checks."

4. After Phase 0 completes (detection.json is regenerated), compute the
   detection hash and compare with `detection_hash` in `.audit-meta.json`:
   ```bash
   jq -S '.all_directories | to_entries | map({key: .key, category: .value.category, languages: .value.languages}) | sort_by(.key)' sdlc-audit/data/detection.json | shasum -a 256 | cut -d' ' -f1
   ```
5. If hashes differ (or `detection_hash` is null from an older audit), warn the user:
   > "Project structure has changed since the last audit (new directories,
   > language changes, or reclassified modules).
   > **Recommendation:** Run a full audit for accurate results."

These are warnings, not blockers — the user can still proceed with
incremental mode if they choose.

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

Each phase runs as its own Task agent (`subagent_type: general-purpose`) with
a clean context window. This prevents stale instructions from earlier phases
from consuming context space during later phases.

**Architecture:**
- The orchestrator spawns one Task agent per phase
- Each Task agent reads its phase instructions file and executes all steps
- The Task agent returns a structured JSON summary
- The orchestrator uses the summary for progress reporting to the user
- Phases communicate exclusively through files in `sdlc-audit/` — not through
  the orchestrator's context

**Before spawning any phase**, resolve these values:
- `PLUGIN_ROOT`: the resolved absolute path of `${CLAUDE_PLUGIN_ROOT}`
- `PROJECT_ROOT`: the project root directory being audited

The shared audit rules (read-only, output isolation) are included in each
Task prompt so phase agents operate independently.

### Phase 0: Discovery

Spawn a Task agent:
- `subagent_type`: `general-purpose`
- `description`: `"Run Phase 0: Discovery"`

Task prompt (substitute PLUGIN_ROOT and PROJECT_ROOT with resolved paths):

```
You are running Phase 0 (Discovery) of a repository audit.

RULES:
- Do NOT modify any existing repository file
- ALL output goes inside sdlc-audit/ — nothing else is touched
- Do NOT create files outside sdlc-audit/

Read and execute ALL instructions in: PLUGIN_ROOT/phases/discovery.md
Project root: PROJECT_ROOT
Plugin root: PLUGIN_ROOT

Execute every step (0-pre through 0g). Write detection.json and all
supporting data to sdlc-audit/data/.

When complete, return a JSON summary (do not write this to disk):
{
  "languages": ["primary languages detected"],
  "frameworks": ["frameworks detected"],
  "total_directories": N,
  "total_files": N,
  "tools_missing": ["missing optional tools"],
  "jq_available": true
}
```

**After the Phase 0 agent returns**, report progress:

> **[1/6] Discovery complete.** Found:
> - [X] languages: [list from summary]
> - [Y] frameworks: [list from summary]
> - [Z] directories to analyze
>
> Starting pre-analysis...

**If incremental mode**, perform the detection hash check now (inline):
1. Compute the detection hash from `sdlc-audit/data/detection.json`
2. Compare with `detection_hash` in `.audit-meta.json`
3. Warn the user if hashes differ (see Version and Configuration Checks above)

### Audit Estimation

This step runs **inline** (not as a Task agent) because it requires user
confirmation via `AskUserQuestion`.

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

Spawn a Task agent:
- `subagent_type`: `general-purpose`
- `description`: `"Run Phase 0.5: Pre-Analysis"`

Task prompt:

```
You are running Phase 0.5 (Pre-Analysis) of a repository audit.

RULES:
- Do NOT modify any existing repository file
- ALL output goes inside sdlc-audit/ — nothing else is touched

Read and execute ALL instructions in: PLUGIN_ROOT/phases/pre-analysis.md
Project root: PROJECT_ROOT
Plugin root: PLUGIN_ROOT

The file sdlc-audit/data/tool-availability.json tells you which tools are
available on this system.

When complete, return a JSON summary (do not write this to disk):
{
  "metrics_collected": true/false,
  "git_history_collected": true/false,
  "linters_run": ["list"],
  "linter_issue_counts": {"tool": N},
  "typecheckers_run": ["list"],
  "typecheck_error_counts": {"tool": N},
  "dep_audit_run": ["list"],
  "vulnerability_counts": {"tool": N},
  "prescan_matches": N,
  "prescan_files": N,
  "skeletons_extracted": ["languages"]
}
```

**After the Phase 0.5 agent returns**, report progress:

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

Before spawning the Phase 1 agent, check `sdlc-audit/modules/` for existing
JSONs with a `sources` field (from a previous sub-command run). Build a list
of existing sources to include in the prompt. If found, report to the user:
> "Found existing analysis from [list sources]. These findings will be
> preserved and enriched by the full audit."

Spawn a Task agent:
- `subagent_type`: `general-purpose`
- `description`: `"Run Phase 1: Deep Analysis"`

Task prompt:

```
You are running Phase 1 (Deep Analysis) of a repository audit.

RULES:
- Do NOT modify any existing repository file
- ALL output goes inside sdlc-audit/ — nothing else is touched

Read and execute ALL instructions in: PLUGIN_ROOT/phases/deep-analysis.md
Project root: PROJECT_ROOT
Plugin root: PLUGIN_ROOT

[If existing sources were found, include this paragraph:]
Existing module analysis found from: [SOURCES_LIST]. Instruct sub-agents to
review but not duplicate existing findings in modules with a "sources" field.

[If incremental mode, include this paragraph:]
INCREMENTAL MODE: Only spawn sub-agents for: [MODULES_TO_REANALYZE].
Preserve existing module JSONs for all other modules.

When complete, return a JSON summary (do not write this to disk):
{
  "files_analyzed": N,
  "directories_analyzed": N,
  "total_issues": N,
  "by_severity": {"critical": N, "warning": N, "info": N},
  "by_confidence": {"definite": N, "high": N, "medium": N, "low": N},
  "sub_agents_spawned": N,
  "validation_failures": []
}
```

The Phase 1 agent manages its own sub-agents internally. It reads
detection.json, plans sub-agent assignments, spawns them, and validates output.

**After the Phase 1 agent returns**, report progress:

> **[3/6] Deep analysis complete.** All [N] sub-agents finished.
> - Analyzed [X] files across [Y] directories
> - Found [Z] issues ([A] critical, [B] warning, [C] info)
> - Confidence breakdown: [D] definite, [E] high, [F] medium, [G] low
>
> Running variant analysis...

### Phase 1.5: Variant Analysis

Spawn a Task agent:
- `subagent_type`: `general-purpose`
- `description`: `"Run Phase 1.5: Variant Analysis"`

Task prompt:

```
You are running Phase 1.5 (Variant Analysis) of a repository audit.

RULES:
- Do NOT modify any existing repository file
- ALL output goes inside sdlc-audit/ — nothing else is touched

Read and execute ALL instructions in: PLUGIN_ROOT/phases/variant-analysis.md
Project root: PROJECT_ROOT
Plugin root: PLUGIN_ROOT

When complete, return a JSON summary (do not write this to disk):
{
  "systemic_patterns_found": N,
  "new_variant_instances": N,
  "patterns": ["brief description of each systemic pattern"]
}
```

**After the Phase 1.5 agent returns**:

> **[4/6] Variant analysis complete:**
> - [N] systemic patterns found (same issue across 3+ modules)
> - [M] new variant instances discovered
>
> Running cross-module analysis...

### Phase 2: Cross-Module Analysis

Spawn a Task agent:
- `subagent_type`: `general-purpose`
- `description`: `"Run Phase 2: Cross-Module Analysis"`

Task prompt:

```
You are running Phase 2 (Cross-Module Analysis) of a repository audit.

RULES:
- Do NOT modify any existing repository file
- ALL output goes inside sdlc-audit/ — nothing else is touched

Read and execute ALL instructions in: PLUGIN_ROOT/phases/cross-module.md
Project root: PROJECT_ROOT
Plugin root: PLUGIN_ROOT

When complete, return a JSON summary (do not write this to disk):
{
  "cross_module_issues": N,
  "dependency_cycles": N,
  "highest_risk_modules": ["top 3 by risk score"],
  "dry_violations": N,
  "inconsistencies": N,
  "architecture_issues": N
}
```

**After the Phase 2 agent returns**:

> **[5/6] Cross-module analysis complete.** Found:
> - [N] cross-module issues (DRY violations, inconsistencies, architecture)
> - Dependency cycles: [count or "none"]
> - Highest-risk modules: [top 3 by risk score]
>
> Generating reports...

### Phase 3: Report Generation

Spawn a Task agent:
- `subagent_type`: `general-purpose`
- `description`: `"Run Phase 3: Report Generation"`

Task prompt:

```
You are running Phase 3 (Report Generation) of a repository audit.

RULES:
- Do NOT modify any existing repository file (except writing to sdlc-audit/)
- ALL output goes inside sdlc-audit/ — nothing else is touched

Read and execute ALL instructions in: PLUGIN_ROOT/phases/report-generation.md
Project root: PROJECT_ROOT
Plugin root: PLUGIN_ROOT
Audit type: [full | incremental]

When complete, return a JSON summary (do not write this to disk):
{
  "reports_generated": ["list of report filenames"],
  "findings": {"critical": N, "warning": N, "info": N},
  "tech_debt_items": N,
  "modules_mapped": N,
  "patterns_documented": N,
  "dependency_modules": N,
  "dependency_cycles": N,
  "test_coverage_pct": "N% modules with tests"
}
```

**After the Phase 3 agent returns**:

> **[6/6] Reports complete.**

### Phase 4: Review and Apply

This phase runs **inline** (not as a Task agent) because it requires direct
user interaction via `AskUserQuestion`.

Read the phase instructions from `${CLAUDE_PLUGIN_ROOT}/phases/review-and-apply.md`
and present the final summary.

**Final summary dashboard** (populate from Phase 3's summary + report files):

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

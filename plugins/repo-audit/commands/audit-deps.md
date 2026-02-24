---
description: Dependency analysis — builds module dependency graph, detects circular dependencies, classifies hub/orphan modules, and scans for external dependency vulnerabilities. Runs in 1-2 minutes.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion
---

# Dependency Audit

Read `${CLAUDE_PLUGIN_ROOT}/phases/shared-preamble.md` for critical rules.

This audit focuses on internal module dependencies and external package health.

---

## Step 1: Explain to User

> **What `/audit-deps` does:**
>
> Analyzes your project's dependency structure:
> - Internal module dependency graph (who imports what)
> - Circular dependency detection
> - Hub modules (too many dependents) and orphans (unused)
> - External package vulnerability scan
> - Duplicate external packages solving the same problem
>
> **Estimated time:** 1-2 minutes
> **Output:** `sdlc-audit/reports/DEPENDENCY_GRAPH.md`
>
> Does NOT modify any of your files.

Ask the user to confirm before proceeding.

## Step 2: Discovery

If `sdlc-audit/data/detection.json` does not exist, read and execute
`${CLAUDE_PLUGIN_ROOT}/phases/discovery.md`.

Report: **[1/4] Discovery complete**

## Step 3: Module Analysis for Dependencies

If `sdlc-audit/modules/*.json` already exist from a previous audit, reuse them.

If not, spawn lightweight sub-agents focused ONLY on extracting dependencies
(not full code analysis). Each sub-agent reads files in its directories and
outputs a minimal JSON:

```
You are extracting dependencies from: [DIRECTORY_PATHS]

Read all source files. Extract ONLY:
- Internal imports (other modules in this project)
- External imports (third-party packages)
- Export list (what this module provides)

Output to sdlc-audit/modules/[directory-name].json:
{
  "directory": "[directory]",
  "directories_analyzed": ["list"],
  "category": "[category]",
  "languages_found": ["list"],
  "purpose": "one-line description",
  "file_count": N,
  "total_lines": N,
  "files": [
    {
      "path": "file.ts",
      "language": "typescript",
      "exports": ["list"],
      "imports_from": {
        "internal": ["list"],
        "external": ["list"]
      }
    }
  ],
  "internal_dependencies": ["module1", "module2"],
  "external_dependencies": ["package1", "package2"],
  "test_coverage": "unknown",
  "documentation_quality": "unknown"
}
```

Report: **[2/4] Module dependencies extracted**

## Step 4: Dependency Graph Analysis

### 4a: Build Dependency Graph

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/build-dep-graph.sh .
```

If jq is not available, read the module JSONs and manually build the graph.

### 4b: External Dependency Audit

Run the dependency audit section from `${CLAUDE_PLUGIN_ROOT}/phases/pre-analysis.md`
(Step 0m only).

### 4c: Dependency Analysis Agent

Spawn a single agent to analyze the dependency graph:

```
You are a dependency graph analyzer.

Read:
- sdlc-audit/data/dependency-data.json (the graph)
- sdlc-audit/data/detection.json (project structure)
- All module JSONs in sdlc-audit/modules/

Analyze and write sdlc-audit/data/dependency-analysis.json:
{
  "problematic_cycles": [
    {
      "modules": ["A", "B"],
      "severity": "critical | warning",
      "why_problematic": "explanation",
      "suggested_fix": "how to break the cycle"
    }
  ],
  "hub_assessment": [
    {
      "module": "name",
      "fan_in": N,
      "is_healthy": true/false,
      "reason": "why this is or isn't concerning"
    }
  ],
  "orphan_assessment": [
    {
      "module": "name",
      "should_keep": true/false,
      "reason": "why"
    }
  ],
  "duplicate_externals": [
    {
      "purpose": "HTTP client",
      "packages": ["axios", "node-fetch"],
      "recommendation": "standardize on one"
    }
  ],
  "decoupling_suggestions": [
    {
      "modules": ["tightly", "coupled"],
      "suggestion": "how to decouple"
    }
  ]
}
```

Report: **[3/4] Dependency analysis complete**

## Step 4d: Merge Dependency Findings into Module JSONs

Merge dependency findings into the standard module JSON format so they can be
reused by subsequent audit commands:

```bash
if [ -f sdlc-audit/data/dependency-analysis.json ]; then
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/merge-module-findings.sh . "sdlc-audit/data/dependency-analysis.json" "audit-deps"
fi
```

This allows `/audit`, `/audit-arch`, `/audit-security`, and other commands to
see dependency findings without re-running the dependency analysis.

## Step 5: Generate Dependency Report

Run the dependency graph assembly script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/assemble-dep-graph.sh .
```

If the script ran successfully, read `sdlc-audit/reports/DEPENDENCY_GRAPH.md`
and append the analysis agent's findings (cycles, hubs, suggestions).

If jq was not available, generate the full report from the module JSONs and
dependency analysis data.

Add a section at the end:

```markdown
## Analysis & Recommendations

### Circular Dependencies
[From dependency-analysis.json — each cycle with severity and fix suggestion]

### Hub Module Assessment
[Assessment of each hub module — healthy vs concerning]

### Orphan Modules
[Unused modules and whether to keep or remove them]

### Duplicate External Packages
[Packages that serve the same purpose — recommendation to consolidate]

### Decoupling Suggestions
[Specific suggestions for reducing coupling between modules]
```

Report: **[4/4] Dependency report complete**

Present summary to user: module count, cycle count, hub count, CVE count.

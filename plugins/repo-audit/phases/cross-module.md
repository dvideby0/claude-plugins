# Phase 2: Cross-Module Analysis

Once ALL sub-agent JSON files are written to `sdlc-audit/modules/`,
Phase 2 runs in two stages: **programmatic analysis** (scripts), then
**parallel LLM agents** for judgment-based work.

## Stage 1: Programmatic Analysis (run sequentially)

Run these scripts first — they produce data files the LLM agents need.

### 2a: Dependency Graph

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/build-dep-graph.sh .
```

### 2b: Risk Scoring

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/compute-risk-scores.sh .
```

### 2c: Incorporate Variant Analysis

Read `sdlc-audit/data/variant-analysis.json` (if it exists from Phase 1.5).
- Merge `variant_search_results` new matches into the relevant module findings
- Systemic patterns feed into the AUDIT_REPORT.md Systemic Patterns section
- Adjust risk scores upward for modules with systemic pattern involvement

## Stage 2: Parallel Cross-Module Agents

Spawn these agents in parallel using Claude Code's Task tool. Each agent reads
ALL module JSONs from `sdlc-audit/modules/` plus the programmatic data files.
Each agent writes its findings as a JSON file to `sdlc-audit/data/`.

**Important:** Each agent works on an independent concern. They read shared
data but write to separate output files, so there are no conflicts.

### Agent: DRY Violations

Spawn with Task tool. The agent reads all module JSONs and writes
`sdlc-audit/data/cross-module-dry.json`.

```
You are a cross-module DRY (Don't Repeat Yourself) analyzer.

Read ALL JSON files in sdlc-audit/modules/. Compare function signatures,
exports, and patterns across modules. Look for:

- Functions with similar names AND similar signatures in different modules
- Duplicated utility logic (string formatting, date handling, validation, HTTP)
- Repeated error handling boilerplate that should be centralized
- Copy-pasted type/struct/class definitions
- Similar validation logic in different modules
- Duplicated constants or configuration values
- Near-identical test setup code across test modules

Write findings to sdlc-audit/data/cross-module-dry.json:
{
  "duplications": [
    {
      "description": "what is duplicated",
      "locations": ["module1/file.ts:fn_name", "module2/file.ts:fn_name"],
      "severity": "warning",
      "confidence": "medium",
      "suggestion": "how to centralize"
    }
  ]
}
```

### Agent: Inconsistencies

Spawn with Task tool. The agent reads all module JSONs and writes
`sdlc-audit/data/cross-module-inconsistencies.json`.

```
You are a cross-module consistency analyzer.

Read ALL JSON files in sdlc-audit/modules/. Compare the patterns field
across ALL files. Look for:

- Mixed naming conventions between modules
- Different error handling strategies for similar operations
- Inconsistent async patterns
- Mixed import styles (relative vs absolute, named vs default)
- Different logging approaches
- Inconsistent use of language features
- Some modules follow the linter config, others don't
- Different approaches to the same category of problem

Write findings to sdlc-audit/data/cross-module-inconsistencies.json:
{
  "inconsistencies": [
    {
      "pattern_type": "naming | error_handling | async | imports | logging | other",
      "description": "what is inconsistent",
      "examples": [
        {"module": "src/auth", "approach": "camelCase"},
        {"module": "src/api", "approach": "snake_case"}
      ],
      "severity": "warning | info",
      "confidence": "medium",
      "recommendation": "which approach to standardize on and why"
    }
  ]
}
```

### Agent: Architecture

Spawn with Task tool. The agent reads all module JSONs plus
`sdlc-audit/data/dependency-data.json` and `sdlc-audit/data/risk-scores.json`.
Writes `sdlc-audit/data/cross-module-architecture.json`.

```
You are a cross-module architecture analyzer.

Read ALL JSON files in sdlc-audit/modules/. Also read:
- sdlc-audit/data/dependency-data.json (dependency graph)
- sdlc-audit/data/risk-scores.json (risk scores)
- sdlc-audit/data/detection.json (project structure)

Analyze:

Architecture concerns:
- God modules (high issue count + high fan-in + many files)
- Layering violations (UI -> DB, tests -> production coupling)
- Missing abstraction boundaries between features
- Feature coupling (one feature's internals imported by another)

Infrastructure <-> Code alignment:
- CI/CD covers all code paths (tests, lint, build, deploy)
- Docker setup matches actual dependencies
- Environment variables in code <-> .env.example <-> CI secrets
- Database migrations match schema used in code
- API specs match actual endpoint implementations

Dependency graph interpretation:
- Which circular deps are problematic vs acceptable
- Which hub modules are healthy vs concerning
- Decoupling suggestions for tightly-coupled modules
- Duplicate external deps solving the same problem (axios AND fetch, etc.)

Risk interpretation:
- Why are the top-risk modules risky?
- Recommended action for each high-risk module

Write findings to sdlc-audit/data/cross-module-architecture.json:
{
  "architecture_issues": [
    {
      "type": "god_module | layering | coupling | infra_mismatch | other",
      "description": "what is wrong",
      "modules": ["affected", "modules"],
      "severity": "critical | warning",
      "confidence": "low",
      "suggestion": "how to fix"
    }
  ],
  "dependency_interpretation": {
    "problematic_cycles": ["description of each"],
    "hub_assessment": ["description of each hub"],
    "decoupling_suggestions": ["suggestion"]
  },
  "risk_interpretation": [
    {"module": "name", "risk_score": 85, "why": "explanation", "action": "recommendation"}
  ],
  "duplicate_externals": [
    {"purpose": "HTTP client", "packages": ["axios", "node-fetch"], "recommendation": "pick one"}
  ]
}
```

### Agent: Test & Documentation Coverage

Spawn with Task tool. The agent reads all module JSONs and writes
`sdlc-audit/data/cross-module-coverage.json`.

```
You are a test and documentation coverage analyzer.

Read ALL JSON files in sdlc-audit/modules/. Analyze:

Test coverage:
- Per-module: tested / partially tested / untested
- Critical UNTESTED paths (high risk + no tests = top priority)
- Missing test categories (unit? integration? e2e? load? security?)
- Test quality issues (tests exist but are shallow)

Documentation coverage:
- Per-module: documented / partially documented / undocumented
- Public API without documentation
- Outdated docs referencing removed code
- Missing architectural documentation

Write findings to sdlc-audit/data/cross-module-coverage.json:
{
  "test_gaps": [
    {
      "module": "src/auth",
      "coverage": "none | partial",
      "missing_types": ["unit", "integration"],
      "risk_note": "why this matters",
      "priority": "critical | high | medium | low"
    }
  ],
  "doc_gaps": [
    {
      "module": "src/api",
      "coverage": "none | partial",
      "missing": ["API docs", "README"],
      "priority": "high | medium | low"
    }
  ],
  "quality_issues": [
    {
      "module": "src/utils",
      "type": "shallow_tests | outdated_docs | missing_edge_cases",
      "description": "what is wrong"
    }
  ]
}
```

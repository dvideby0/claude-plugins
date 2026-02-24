# Phase 1: Exhaustive Directory Scan (Sub-Agents)

Read `sdlc-audit/data/detection.json`.

**Do NOT pre-load all language guides.** Instead, for each sub-agent, read ONLY
the guide files listed in that directory's `guide_files` field from detection.json.
This means a sub-agent analyzing a pure Python directory only loads `python.md`,
not every language guide in the project.

**How to load guide files:** Read the file content from the path specified in
`guide_files` (e.g., `${CLAUDE_PLUGIN_ROOT}/lang/python.md`) and include that
content directly in the sub-agent's task prompt. The sub-agent itself does NOT
need access to the guide files — you (the orchestrator) read them and inject the
content into the sub-agent's task description.

## Directory Classification

Classify EVERY directory from the `all_directories` map:

| Category            | Examples                                        | Guide to Use                    |
|--------------------|-------------------------------------------------|---------------------------------|
| **source**         | `src/`, `lib/`, `app/`, `pkg/`, `internal/`    | Language-specific guide         |
| **tests**          | `tests/`, `test/`, `spec/`, `__tests__/`       | Language guide + test sections  |
| **scripts**        | `scripts/`, `bin/`, `tools/`, `hack/`           | General guide + lang if known   |
| **config**         | Root dotfiles, manifests, linter configs         | Infrastructure guide            |
| **ci_cd**          | `.github/workflows/`, `.gitlab-ci.yml`           | Infrastructure guide            |
| **infrastructure** | `infra/`, `terraform/`, `deploy/`, `k8s/`, `helm/` | Infrastructure guide         |
| **database**       | `migrations/`, `seeds/`, `prisma/`, `db/`, `sql/` | Infrastructure + lang guide   |
| **docs**           | `docs/`, `wiki/`, `*.md` collections             | Documentation completeness      |
| **generated**      | `dist/`, `build/`, `node_modules/`, `.next/`     | **SKIP**                        |
| **vendored**       | `vendor/`, `.venv/`, `Pods/`, `third_party/`     | **SKIP**                        |

**Nothing is skipped except generated and vendored code.**

## Sub-Agent Assignment Plan

Before spawning any sub-agents, create an explicit assignment plan.
Pull the `languages` and `guide_files` for each directory directly from
`detection.json` — do NOT guess or infer languages at this stage:

```
Sub-Agent 1: src/auth/, src/middleware/
  languages: [typescript]  (from detection.json)
  guides: [typescript.md]  (from detection.json)
  ~17 files

Sub-Agent 2: src/api/
  languages: [typescript]
  guides: [typescript.md]
  ~24 files
```

**Assignment rules:**
- Every directory from `all_directories` MUST appear in exactly one sub-agent assignment
- Each sub-agent's `languages` and `guides` come DIRECTLY from the directory's
  `languages` and `guide_files` fields in `detection.json` — do not infer or guess
- When batching directories, the sub-agent receives the UNION of guide files
  for all directories in its batch (deduplicated)
- Directories with < 5 files: batch 3-5 related directories per sub-agent
- Directories with 5-20 files: one directory per sub-agent
- Directories with 20+ files: split into sub-directories, one sub-agent each
- Root-level config files always get a dedicated sub-agent
- CI/CD always gets a dedicated sub-agent (or shares with infra)
- Prefer batching directories that share the SAME language guides together
  (don't batch a Python dir with a Go dir if avoidable — it wastes context
  loading both guides when each sub-agent only needs one)
- Cap at **20 sub-agents** for normal repos, **30 for monorepos or 500+ file repos**
- **Verify**: after planning, check that the union of all sub-agent assignments
  equals the complete set of directories. If any directory is missing, add it.
- **Incremental mode**: if running an incremental audit, only spawn sub-agents
  for directories in the `modules_to_reanalyze` list. Existing module JSONs in
  `sdlc-audit/modules/` are preserved for unchanged directories. All directories
  still appear in the assignment plan (mark reused ones as "reused from previous audit").

## Sub-Agent Task Template

Each sub-agent receives this task, filled in with its specific assignments.
**Only include the guide content for languages found in that directory** —
if a sub-agent is analyzing a pure Python directory, it receives ONLY
`python.md` content, not typescript or rust guides:

```
You are analyzing: [DIRECTORY_PATHS]
Category: [source | tests | scripts | config | ci_cd | infrastructure | docs | database]
Languages in these directories: [LANGUAGES FROM detection.json]

=== LANGUAGE GUIDE (only for languages present in your directories) ===
[Content of ONLY the guide files from this directory's guide_files list]
[e.g., if guide_files is ["python.md"], insert ONLY python.md content here]
[if guide_files is ["typescript.md", "infrastructure.md"], insert both]
[if guide_files is empty, skip this section entirely]
=== END LANGUAGE GUIDE ===

=== FILE SKELETONS (if available for your languages) ===
[Include skeleton data from sdlc-audit/data/skeletons/ filtered to this sub-agent's directories.
If skeletons exist, the structural data (imports, exports, function signatures) is deterministic
and accurate. Use it directly for the "exports", "imports_from", and "functions" fields in your
JSON output instead of manually extracting this information.]
=== END SKELETONS ===

Read EVERY file in your assigned directory/directories recursively.
Do not skip any file. If a file is too large to read fully (> 1000 lines),
read the first 200 lines, last 100 lines, and all exported/public interfaces.

If skeleton data was provided, you do NOT need to extract imports, exports,
or function signatures manually — use the skeleton data. Focus your reading
on UNDERSTANDING the code: patterns, issues, quality, purpose, and semantic
concerns that require judgment.

For each file produce analysis according to the guide criteria.

Output structured JSON to sdlc-audit/modules/[directory-name].json:

{
  "directory": "[primary directory]",
  "directories_analyzed": ["full", "list", "of", "dirs"],
  "category": "[category]",
  "languages_found": ["typescript", "yaml"],
  "purpose": "one-line description of what this module/area does",
  "file_count": 12,
  "total_lines": 1847,
  "files": [
    {
      "path": "src/auth/oauth.ts",
      "language": "typescript",
      "lines": 245,
      "purpose": "what this file does",
      "exports": ["authenticateUser", "refreshToken", "OAuthConfig"],
      "imports_from": {
        "internal": ["src/utils/http", "src/config"],
        "external": ["jsonwebtoken", "axios"]
      },
      "patterns": {
        "error_handling": "description of approach used",
        "async_style": "async/await | promises | callbacks | mixed",
        "naming_convention": "camelCase | snake_case | PascalCase | mixed",
        "type_safety": "strict | loose | none",
        "has_tests": true,
        "documentation": "well-documented | sparse | none"
      },
      "functions": [
        {
          "name": "authenticateUser",
          "visibility": "public | private | internal",
          "params": "credentials: Credentials",
          "returns": "Promise<User>",
          "line_range": [12, 58],
          "complexity": "low | medium | high",
          "description": "what it does in one line"
        }
      ],
      "issues": [
        {
          "severity": "critical | warning | info",
          "confidence": "definite | high | medium | low",
          "category": "security | performance | maintainability | dry | consistency | correctness | testing | documentation",
          "source": "linter | typecheck | prescan | llm-analysis",
          "description": "what's wrong",
          "line_range": [45, 52],
          "suggestion": "how to fix it",
          "guide_rule": "which check from the language guide triggered this"
        }
      ]
    }
  ],
  "internal_dependencies": ["src/utils", "src/db"],
  "external_dependencies": ["jsonwebtoken", "axios"],
  "module_level_issues": [
    {
      "severity": "warning",
      "confidence": "medium",
      "category": "maintainability",
      "source": "llm-analysis",
      "description": "module-wide concern"
    }
  ],
  "test_coverage": "full | partial | none | not-applicable",
  "documentation_quality": "comprehensive | adequate | sparse | missing"
}
```

### Confidence Scoring Rules

Every issue MUST include a `confidence` and `source` field.

The canonical confidence/severity/source enum definitions and confidence weights
are defined in `${CLAUDE_PLUGIN_ROOT}/schemas/enums.json`. The defaults are:

| Source | Default Confidence | Description |
|--------|-------------------|-------------|
| `linter` | `definite` | From deterministic linter output (eslint, ruff, etc.). These are facts. |
| `typecheck` | `definite` | From compiler/type checker (tsc, mypy, go vet). Authoritative. |
| `prescan` | `high` | From grep-based pattern detection. Pattern matched but context might make it valid. |
| `llm-analysis` | `medium` | From sub-agent code reading with clear evidence (specific code cited). |
| `cross-module` | `low` | From cross-module analysis or architectural opinions. Subjective. |

Risk scoring weights issues by confidence (definite=1.0, high=0.8, medium=0.5,
low=0.2). Higher-confidence issues contribute more to a module's risk score.

Sub-agents may upgrade confidence from the default when evidence is strong
(e.g., an `llm-analysis` finding of SQL injection with visible string
concatenation can be `high`). They should NOT downgrade `definite` findings
from tools.

### Category-Specific Instructions

For **config** and **ci_cd** sub-agents, the file analysis focuses on:
- Correctness and completeness of configuration
- Security issues (exposed secrets, permissive settings)
- Consistency with the actual codebase
- Missing recommended configurations

For **docs** sub-agents, the analysis focuses on:
- Which docs exist vs what's missing (README, CONTRIBUTING, CHANGELOG, API docs, architecture docs)
- Staleness (do docs reference things that no longer exist in the code?)
- Completeness (are all public APIs documented?)
- Accuracy (do examples actually match current code patterns?)

## Post-Analysis Validation

After all sub-agents complete (and any missing modules have been re-spawned),
run the schema validator on all module JSONs:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/validate-module-json.sh .
```

If validation fails, read `sdlc-audit/data/validation-results.json` to identify
which modules have schema errors. For each failed module:

1. Read the error details to understand what's wrong
2. Re-spawn a sub-agent for that module with an explicit note about the schema
   requirement that was violated
3. Re-validate after the re-spawn

If a module fails validation twice, flag it to the user and proceed (don't
loop indefinitely).

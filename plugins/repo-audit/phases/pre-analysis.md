# Phase 0.5: Pre-Analysis (Programmatic)

These steps use fast, deterministic tools to gather data before sub-agents run.
The sub-agents will still work without the pre-analysis data, just slower.

## Steps 0h–0n (except 0j): Run All Deterministic Tools

A single script handles all bash-based tools: code metrics (cloc/tokei),
git history analysis, linters, type checkers, dependency audits, and code
skeleton extraction. The script reads `tool-availability.json` to decide
which tools to run, logs all failures to a debug file, and always exits 0
(failures never cascade to kill sibling tool calls).

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/run-pre-analysis-tools.sh .
```

**Output locations:**
- Code metrics: `sdlc-audit/data/metrics.json`
- Git data: `sdlc-audit/data/git-hotspots.txt`, `sdlc-audit/data/git-busfactor.txt`
- Linter results: `sdlc-audit/tool-output/linter-results/*.json`
- Type checker results: `sdlc-audit/tool-output/typecheck/*.txt`
- Dependency audit results: `sdlc-audit/tool-output/deps/*.json`
- Code skeletons: `sdlc-audit/data/skeletons/*`
- **Failure log: `sdlc-audit/data/pre-analysis-failures.log`** (for debugging)

The failure log contains timestamped entries for every tool that exited non-zero,
along with stderr output. An empty log (just the header) means everything succeeded.

If metrics were collected, use the line counts from `metrics.json` for the
`total_lines` and per-file `lines` fields in sub-agent JSON output. Include
a summary in the sub-agent prompt so they don't waste time counting.

The hotspot data feeds into Phase 2 risk scoring. Files changed frequently
are higher risk.

**Sub-agent instruction update:** When linter results exist for a sub-agent's
directories, include them in the prompt:

```
=== LINTER RESULTS (from repo's own tools — confidence: definite) ===
[filtered linter output for files in this sub-agent's directories]
=== END LINTER RESULTS ===

Do NOT re-report issues already captured by linters unless you have additional
context. Focus on: architectural concerns, semantic bugs, cross-file patterns,
DRY violations, and issues that require understanding intent.
```

Include type-check results in sub-agent prompts for relevant directories:
```
=== TYPE CHECK RESULTS (confidence: definite) ===
[filtered type errors for files in this sub-agent's directories]
=== END TYPE CHECK ===

Type errors from the compiler are authoritative. Analyze whether they reveal
deeper design problems or patterns (e.g., same type mismatch in 20 places
= missing abstraction).
```

Vulnerability results feed into Phase 3 AUDIT_REPORT.md (Dependency
Vulnerabilities section) and TECH_DEBT.md (Quick Wins — version bumps).

If NO audit tools are installed for detected languages, add an info-level finding:
"No dependency audit tools installed. Consider installing [tool] for automated
vulnerability detection."

## Step 0j: Pattern Pre-Scan

Use Grep (Claude Code's built-in grep tool, which uses ripgrep) to find
pattern-matchable issues BEFORE sub-agents run. Only scan for languages
detected in Phase 0. Store results so they can be injected into sub-agent prompts.

**For TypeScript/JavaScript** (if detected):
- Search for `any` type usage: pattern `\bany\b` in `*.ts`, `*.tsx`
- Search for `@ts-ignore` / `@ts-expect-error`: pattern `@ts-ignore|@ts-expect-error` in `*.ts`, `*.tsx`
- Search for `console.log` left in: pattern `console\.(log|debug|info)` in `*.ts`, `*.tsx`, `*.js`, `*.jsx`
- Search for `as any`: pattern `as any` in `*.ts`, `*.tsx`

**For Python** (if detected):
- Search for `eval`/`exec`: pattern `eval\(|exec\(` in `*.py`
- Search for bare except: pattern `except\s*:` in `*.py`
- Search for `import *`: pattern `from .* import \*` in `*.py`
- Search for mutable defaults: pattern `def .*=\s*\[\]|def .*=\s*\{\}` in `*.py`
- Search for pickle.load: pattern `pickle\.load` in `*.py`
- Search for subprocess shell=True: pattern `subprocess.*shell\s*=\s*True` in `*.py`
- Search for unsafe yaml: pattern `yaml\.load\(` in `*.py`

**For Go** (if detected):
- Search for fmt.Print (debug leftover): pattern `fmt\.Print` in `*.go`

**For all languages:**
- Search for hardcoded secrets: pattern `(?i)(password|api_key|secret|token)\s*=\s*["']` in all files
- Search for TODO/FIXME: pattern `TODO|FIXME|HACK|XXX` in all files

Run each search using Claude Code's Grep tool (NOT bash grep). Collect results
and write a summary to `sdlc-audit/prescan/prescan-summary.txt` with counts:

```
TypeScript patterns:
  any usage: 23 instances across 12 files
  @ts-ignore: 5 instances across 3 files
  console.log: 8 instances across 6 files
Python patterns:
  bare except: 3 instances across 2 files
  eval/exec: 0 instances
General:
  Potential hardcoded secrets: 2 instances across 1 file
  TODO/FIXME: 45 instances across 22 files
```

Include the relevant pre-scan results in each sub-agent's prompt (filtered to
their assigned directories) in a section:

```
=== PRE-SCAN FINDINGS (grep-detected patterns — confidence: high) ===
[filtered prescan results for this sub-agent's directories only]
=== END PRE-SCAN ===
```

This helps sub-agents focus on UNDERSTANDING issues rather than FINDING them.

## Step 0n: Code Skeleton Extractors

Skeleton extractors run automatically via `run-pre-analysis-tools.sh` for all
detected languages. The following extractors are available:

| Language              | Script                        | Output                                        |
|-----------------------|-------------------------------|-----------------------------------------------|
| Python                | `extract-skeletons.py`        | `sdlc-audit/data/skeletons/python.json`       |
| TypeScript/JavaScript | `extract-skeletons-ts.sh`     | `sdlc-audit/data/skeletons/typescript.json`   |
| Go                    | `extract-skeletons-go.sh`     | `sdlc-audit/data/skeletons/go.json`           |
| Rust                  | `extract-skeletons-rust.sh`   | `sdlc-audit/data/skeletons/rust.json`         |
| Java                  | `extract-skeletons-java.sh`   | `sdlc-audit/data/skeletons/java.json`         |

Each extractor uses grep (rg if available, fallback to grep) to extract
structural data: imports, exports/declarations, function/method signatures,
and type definitions. No language-specific toolchains are required.

Skeletons are an optimization, not a requirement. If no extractors succeed,
sub-agents will extract structure manually (slower but functional).

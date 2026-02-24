# Phase 0.5: Pre-Analysis (Programmatic)

These steps use fast, deterministic tools to gather data before sub-agents run.
Check `sdlc-audit/data/tool-availability.json` before each step — only run tools
that are available. Skip unavailable tools silently (the sub-agents will still
work without the pre-analysis data, just slower).

## Step 0h: Code Metrics

**If `cloc` is available** (check tool-availability.json):
```bash
cloc . --json --exclude-dir=node_modules,dist,build,.venv,venv,.next,target,obj,vendor,__pycache__,.git,coverage,deps,_build,.dart_tool,Pods,sdlc-audit --by-file 2>/dev/null > sdlc-audit/data/metrics.json
```

**Else if `tokei` is available:**
```bash
tokei . --output json --exclude node_modules dist build .venv target obj vendor sdlc-audit 2>/dev/null > sdlc-audit/data/metrics.json
```

**Else:** Skip this step. Sub-agents will count lines manually (current behavior).

If metrics were collected, use the line counts from `metrics.json` for the
`total_lines` and per-file `lines` fields in sub-agent JSON output. Include
a summary in the sub-agent prompt so they don't waste time counting.

## Step 0i: Git History Analysis

**Only if `.git` directory exists.** Run the git analysis script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/git-analysis.sh .
```

This produces `sdlc-audit/data/git-hotspots.txt` and `sdlc-audit/data/git-busfactor.txt`.

**If `.git` does not exist:** Skip entirely. Note in detection.json: `"git_available": false`.

The hotspot data feeds into Phase 2 risk scoring. Files changed frequently
are higher risk.

## Step 0k: Run Existing Linters

If the repo has linters configured (detected in Step 0e), run them and capture
the output. This gives sub-agents authoritative findings so they don't waste
time rediscovering what linters already know.

**Only run tools that are installed and configured in the repo.**
Check `sdlc-audit/data/tool-availability.json` for availability.
Each command has a 60-second timeout. Failures are non-blocking — skip and continue.

```bash
mkdir -p sdlc-audit/tool-output/linter-results
```

| Detected Config | Condition | Command | Output |
|----------------|-----------|---------|--------|
| .eslintrc* or eslint in package.json | `node_modules/.bin/eslint` exists | `npx eslint . --format json 2>/dev/null \| head -5000` | `sdlc-audit/tool-output/linter-results/eslint.json` |
| ruff.toml or [tool.ruff] in pyproject.toml | `ruff` available | `ruff check . --output-format json 2>/dev/null \| head -5000` | `sdlc-audit/tool-output/linter-results/ruff.json` |
| biome.json | `node_modules/.bin/biome` exists | `npx biome check . --reporter json 2>/dev/null \| head -5000` | `sdlc-audit/tool-output/linter-results/biome.json` |
| .golangci.yml | `golangci-lint` available | `golangci-lint run --out-format json 2>/dev/null \| head -5000` | `sdlc-audit/tool-output/linter-results/golangci.json` |
| .rubocop.yml | `rubocop` available | `rubocop --format json 2>/dev/null \| head -5000` | `sdlc-audit/tool-output/linter-results/rubocop.json` |

Run each applicable command and save output. If a tool isn't installed, skip it
and note it in the Phase 0.5 progress report.

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

## Step 0l: Type Checking

Run language-native type checkers to get authoritative type error data.

```bash
mkdir -p sdlc-audit/tool-output/typecheck
```

**TypeScript** (if tsconfig.json exists and tsc is available):
```bash
npx tsc --noEmit --pretty false 2>&1 | head -500 > sdlc-audit/tool-output/typecheck/tsc.txt
echo "EXIT_CODE=$?" >> sdlc-audit/tool-output/typecheck/tsc.txt
```

**Go** (if go.mod exists and go is available):
```bash
go vet ./... 2>&1 | head -200 > sdlc-audit/tool-output/typecheck/govet.txt
```

**Rust** (if Cargo.toml exists and cargo is available):
```bash
cargo check --message-format short 2>&1 | head -200 > sdlc-audit/tool-output/typecheck/cargo-check.txt
```

Each command has a 120-second timeout. If a tool isn't available, skip it.

Include type-check results in sub-agent prompts for relevant directories:
```
=== TYPE CHECK RESULTS (confidence: definite) ===
[filtered type errors for files in this sub-agent's directories]
=== END TYPE CHECK ===

Type errors from the compiler are authoritative. Analyze whether they reveal
deeper design problems or patterns (e.g., same type mismatch in 20 places
= missing abstraction).
```

## Step 0m: Dependency Vulnerability Audit

Run language-native dependency audit tools to check for known CVEs.
The LLM cannot detect these — only vulnerability databases can.

```bash
mkdir -p sdlc-audit/tool-output/deps
```

| Detected Manifest | Condition | Command | Output |
|------------------|-----------|---------|--------|
| package-lock.json | npm available | `npm audit --json 2>/dev/null` | `sdlc-audit/tool-output/deps/npm-audit.json` |
| yarn.lock | yarn available | `yarn audit --json 2>/dev/null` | `sdlc-audit/tool-output/deps/yarn-audit.json` |
| pnpm-lock.yaml | pnpm available | `pnpm audit --json 2>/dev/null` | `sdlc-audit/tool-output/deps/pnpm-audit.json` |
| requirements.txt or pyproject.toml | `pip-audit` available | `pip-audit --format json 2>/dev/null` | `sdlc-audit/tool-output/deps/pip-audit.json` |
| Cargo.lock | `cargo-audit` available | `cargo audit --json 2>/dev/null` | `sdlc-audit/tool-output/deps/cargo-audit.json` |
| go.sum | `govulncheck` available | `govulncheck ./... 2>/dev/null` | `sdlc-audit/tool-output/deps/govulncheck.txt` |
| Gemfile.lock | `bundle-audit` available | `bundle-audit check 2>/dev/null` | `sdlc-audit/tool-output/deps/bundle-audit.txt` |
| composer.lock | composer available | `composer audit --format json 2>/dev/null` | `sdlc-audit/tool-output/deps/composer-audit.json` |

Each command has a 120-second timeout (these tools query remote databases).
If a tool isn't installed, skip it and note in the progress report.
If a lock file is missing, skip that ecosystem.

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

## Step 0n: Extract Code Skeletons (Deterministic)

Extract structured metadata (imports, exports, function signatures) from source
files using deterministic tools. This gives sub-agents accurate structural data
so they can focus on semantic analysis rather than parsing.

```bash
mkdir -p sdlc-audit/data/skeletons
```

**Python** (only if Python files are detected AND `python3` is available on the
system — this is the one script that uses Python because it needs the built-in
`ast` module for accurate AST parsing. If `python3` is not available, skip this):
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/extract-skeletons.py .
```

**TypeScript/JavaScript** (if detected — grep-based, zero dependencies):

Use Claude Code's Grep tool (not bash grep) to extract structural data.
Run these searches and compile the results into `sdlc-audit/data/skeletons/typescript.json`:

1. Extract exports: search pattern `^export\s+(default\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\s+\w+` in `*.ts`, `*.tsx`, `*.js`, `*.jsx`
2. Extract imports: search pattern `^import\s+` in `*.ts`, `*.tsx`, `*.js`, `*.jsx`
3. Extract function signatures: search pattern `(export\s+)?(async\s+)?function\s+\w+\s*\(` in `*.ts`, `*.tsx`

Compile the grep results into a JSON structure per file:
```json
{
  "src/auth/oauth.ts": {
    "exports": ["authenticateUser (function)", "OAuthConfig (interface)"],
    "imports": ["jsonwebtoken", "../utils/http"],
    "functions": ["authenticateUser", "refreshToken"],
    "line_count": 245
  }
}
```

Write to `sdlc-audit/data/skeletons/typescript.json`.

**Go** (if detected and `go` is available):
```bash
go doc -all ./... 2>/dev/null | head -2000 > sdlc-audit/data/skeletons/go-api.txt
```

**Other languages** — generic grep-based extraction:

Use Claude Code's Grep tool to search for:
- Pattern `^(pub |public |export |def |func |fn |fun )` in relevant file types
- Write results to `sdlc-audit/data/skeletons/generic.json`

**Each collector:**
- Has a 60-second timeout
- Handles errors gracefully (skip file, continue)
- Skips files in excluded directories
- Outputs to `sdlc-audit/data/skeletons/<language>.json`

**If no collectors succeed:** Skip entirely. Sub-agents will extract structure
manually (current behavior). Skeletons are an optimization, not a requirement.

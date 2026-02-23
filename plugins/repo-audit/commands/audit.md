---
description: Full repository audit — auto-detects languages and frameworks, spawns sub-agents per module, generates audit reports, dependency graphs, and staged CLAUDE.md proposals
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
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
2. **Deep analysis** (~3-10 minutes) — Spawns sub-agents to analyze each module in parallel
3. **Cross-reference** (~1-2 minutes) — Correlates findings across modules
4. **Reports** (~1 minute) — Generates actionable markdown reports

**Estimated time:** 5-15 minutes depending on repo size.

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
   - New directories not in the previous `detection.json` → force full audit
   - Deleted directories → force full audit
   - If > 50% of modules are affected → suggest full audit instead

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

## Phase 0: Discovery

### Step 0-pre: Prerequisites Check

Run the prerequisite checker to detect available tools on the user's system:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/check-prereqs.sh .
```

Read `sdlc-audit/data/tool-availability.json` to determine which tools are
available and which are missing.

**If there are missing tools**, you MUST notify the user using `AskUserQuestion`
before proceeding. Build the question dynamically from the JSON data:

- List each missing tool by name with a brief description of what it enables
- Include the combined install command from `install_commands.all_missing`
- Present the user with these options:
  1. **"Install and re-check"** — The user will install the tools themselves.
     After they select this, run `check-prereqs.sh` again to refresh
     `tool-availability.json`, then continue with the updated availability.
  2. **"Proceed without them"** — Continue the audit using LLM-based fallbacks
     for any missing tool capabilities. The audit still works, but will be
     slower and less thorough for the affected checks.

Example question format:
> "The following optional tools are missing: **rg** (fast pattern scanning),
> **tree** (directory visualization). These make the audit faster and more
> thorough. To install, run: `brew install ripgrep && brew install tree`.
> How would you like to proceed?"

**If all tools are available**, skip the prompt and continue immediately.

Throughout all subsequent phases, check `tool-availability.json` before using
any optional tool. If a tool is not available, use the fallback approach
specified in that phase's instructions (or skip the optimization).

### Step 0a: Full Directory Map
Run a complete structural scan of the repository.

**Directory tree** (if `tree` is available):
```bash
tree -L 4 -a -I 'node_modules|.git|dist|build|__pycache__|vendor|.venv|venv|.next|target|bin/Debug|bin/Release|obj|.gradle|.idea|.vs|coverage|.mypy_cache|.ruff_cache|.pytest_cache|.tox|deps|_build|.dart_tool|.pub-cache|Pods|sdlc-audit' --dirsfirst
```

If `tree` is not available, use `ls -R` or Claude Code's Glob tool with `**/*` to
build a directory listing.

**File extension census and counts** — run as a single bash command:
```bash
find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/__pycache__/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/.next/*' -not -path '*/target/*' -not -path '*/obj/*' -not -path '*/.gradle/*' -not -path '*/Pods/*' -not -path '*/coverage/*' -not -path '*/sdlc-audit/*' | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -50
```

**File and directory counts** — run as a single bash command:
```bash
echo "Files:" && find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.venv/*' -not -path '*/target/*' -not -path '*/obj/*' -not -path '*/sdlc-audit/*' | wc -l && echo "Directories:" && find . -type d -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.venv/*' -not -path '*/target/*' -not -path '*/obj/*' -not -path '*/sdlc-audit/*' | wc -l
```

### Step 0b: Language Detection via Manifests

Use Claude Code's **Glob tool** (not bash) to detect manifests. Run these
glob searches in parallel — each is independent:

1. `**/package.json` — JavaScript/TypeScript
2. `**/tsconfig.json` and `**/tsconfig.*.json` — TypeScript
3. `**/requirements.txt`, `**/pyproject.toml`, `**/setup.py`, `**/setup.cfg`, `**/Pipfile` — Python
4. `**/go.mod` — Go
5. `**/Cargo.toml` — Rust
6. `**/pom.xml`, `**/build.gradle`, `**/build.gradle.kts` — Java/Kotlin
7. `**/Gemfile` — Ruby
8. `**/composer.json` — PHP
9. `**/*.csproj`, `**/*.sln`, `**/Directory.Build.props` — C#/.NET
10. `**/Package.swift` — Swift
11. `**/mix.exs` — Elixir
12. `**/pubspec.yaml` — Dart/Flutter
13. `**/CMakeLists.txt`, `**/Makefile` — C/C++
14. `**/build.sbt`, `**/build.sc` — Scala
15. `**/deno.json`, `**/deno.jsonc` — Deno (use TS guide)
16. `**/bun.lockb` — Bun (use TS guide)

Ignore any results inside `node_modules/`, `.git/`, `vendor/`, `dist/`,
`build/`, `.venv/`, `target/`, `obj/`, or `sdlc-audit/` directories.

You can batch several glob patterns into a single Glob call using
`**/{package.json,tsconfig.json,go.mod,Cargo.toml,Gemfile}` syntax for efficiency.

Manifest → Language mapping:

| Manifest                                     | Language/Platform    |
|----------------------------------------------|----------------------|
| `package.json`                               | JavaScript/TypeScript|
| `tsconfig.json` / `tsconfig.*.json`          | TypeScript           |
| `requirements.txt` / `pyproject.toml` / `setup.py` / `setup.cfg` / `Pipfile` | Python |
| `go.mod`                                     | Go                   |
| `Cargo.toml`                                 | Rust                 |
| `pom.xml` / `build.gradle` / `build.gradle.kts` | Java/Kotlin       |
| `Gemfile`                                    | Ruby                 |
| `composer.json`                              | PHP                  |
| `*.csproj` / `*.sln` / `Directory.Build.props` | C#/.NET           |
| `Package.swift`                              | Swift                |
| `mix.exs`                                    | Elixir               |
| `pubspec.yaml`                               | Dart/Flutter         |
| `CMakeLists.txt` / `Makefile`                | C/C++                |
| `build.sbt` / `build.sc`                     | Scala                |
| `deno.json` / `deno.jsonc`                   | Deno (use TS guide)  |
| `bun.lockb`                                  | Bun (use TS guide)   |

For each detected manifest, READ IT to extract framework and dependency info.

### Step 0c: Language → Guide File Mapping
Map each detected language to its audit guide:

| Detected Language     | Guide File                                    |
|----------------------|-----------------------------------------------|
| JavaScript           | `${CLAUDE_PLUGIN_ROOT}/lang/typescript.md`   |
| TypeScript           | `${CLAUDE_PLUGIN_ROOT}/lang/typescript.md`   |
| Deno / Bun           | `${CLAUDE_PLUGIN_ROOT}/lang/typescript.md`   |
| Python               | `${CLAUDE_PLUGIN_ROOT}/lang/python.md`       |
| Go                   | `${CLAUDE_PLUGIN_ROOT}/lang/go.md`           |
| Rust                 | `${CLAUDE_PLUGIN_ROOT}/lang/rust.md`         |
| Java                 | `${CLAUDE_PLUGIN_ROOT}/lang/java.md`         |
| Kotlin               | `${CLAUDE_PLUGIN_ROOT}/lang/java.md`         |
| Ruby                 | `${CLAUDE_PLUGIN_ROOT}/lang/ruby.md`         |
| PHP                  | `${CLAUDE_PLUGIN_ROOT}/lang/php.md`          |
| C#/.NET              | `${CLAUDE_PLUGIN_ROOT}/lang/csharp.md`       |
| Swift                | `${CLAUDE_PLUGIN_ROOT}/lang/swift.md`        |
| Elixir               | `${CLAUDE_PLUGIN_ROOT}/lang/elixir.md`       |
| Dart/Flutter         | `${CLAUDE_PLUGIN_ROOT}/lang/dart.md`         |
| C/C++                | `${CLAUDE_PLUGIN_ROOT}/lang/c_cpp.md`        |
| Scala                | `${CLAUDE_PLUGIN_ROOT}/lang/scala.md`        |
| Any other language   | `${CLAUDE_PLUGIN_ROOT}/lang/general.md`      |

If a guide file doesn't exist for a detected language, fall back to `general.md`.

For **config**, **ci_cd**, and **infrastructure** category directories, always
include `infrastructure.md` in their `guide_files` regardless of file extensions.

### Step 0d: Framework Detection
Read manifests and check for framework-specific config files:

- `next.config.*` → Next.js
- `angular.json` → Angular
- `svelte.config.*` → SvelteKit
- `nuxt.config.*` → Nuxt
- `astro.config.*` → Astro
- `remix.config.*` / `app/root.tsx` → Remix
- `manage.py` / `django/` → Django
- `config/routes.rb` → Rails
- `artisan` → Laravel
- `bin/console` → Symfony
- `application.conf` → Play Framework (Scala)

### Step 0e: Tooling Detection

Use Claude Code's **Glob tool** to detect tooling configs. Run these searches
(you can batch related patterns into a single Glob call):

**Linters:**
- `**/{.eslintrc*,biome.json,ruff.toml,.golangci.yml,clippy.toml,.rubocop.yml,phpstan.neon,.swiftlint.yml,analysis_options.yaml,.clang-tidy,.credo.exs,scalafmt.conf}`
- Also check: if `pyproject.toml` exists, use Grep to check for `\[tool\.ruff\]` section

**Formatters:**
- `**/{.prettierrc*,rustfmt.toml,.editorconfig,.scalafmt.conf}`

**Testing:**
- `**/{jest.config*,vitest.config*,pytest.ini,conftest.py,phpunit.xml,test_helper.rb,.xctestplan}`

**CI/CD:**
- `**/{.gitlab-ci.yml,Jenkinsfile,bitbucket-pipelines.yml,.travis.yml,azure-pipelines.yml}`
- Also check directories: `.github/workflows/`, `.circleci/`

**Containers:**
- `**/Dockerfile*`, `**/docker-compose*.yml`, `**/.dockerignore`

**Infrastructure as Code:**
- `**/*.tf`, `**/serverless.yml`, `**/cdk.json`, `**/pulumi.*`
- Also check directories: `terraform/`, `k8s/`, `helm/`, `ansible/`

**API Specs:**
- `**/{openapi.yaml,openapi.yml,swagger.json}`, `**/*.graphql`, `**/*.proto`

**Monitoring:**
- `**/{prometheus.yml,datadog.yaml,sentry.*}`

**Pre-commit:**
- `**/{.pre-commit-config.yaml,.lefthook.yml}`
- Also check directory: `.husky/`

**Framework detection** (can run in the same pass):
- `**/next.config.*` → Next.js
- `**/angular.json` → Angular
- `**/svelte.config.*` → SvelteKit
- `**/nuxt.config.*` → Nuxt
- `**/astro.config.*` → Astro

Ignore results inside `node_modules/`, `.git/`, `vendor/`, `dist/`, `build/`,
`.venv/`, `target/`, `obj/`, or `sdlc-audit/` directories.

Use the results to build the `tooling` section of detection.json.

### Step 0f: Per-Directory Language Scan

Scan ALL directories in a single pass to determine which languages are present
in each directory. Do NOT run a separate command per directory:

Run as a single bash command (all on one line — do NOT split across multiple lines):
```bash
find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/__pycache__/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/.next/*' -not -path '*/target/*' -not -path '*/obj/*' -not -path '*/.gradle/*' -not -path '*/Pods/*' -not -path '*/coverage/*' -not -path '*/sdlc-audit/*' | awk -F/ '{dir=""; for(i=1;i<NF;i++) dir=dir (i>1?"/":"") $i; if(dir=="") dir="."; n=split($NF,p,"."); ext=(n>1)?p[n]:"none"; print dir "\t" ext}' | sort | uniq -c | sort -rn
```

This produces output like:
```
  15  src/auth     ts
   3  src/auth     json
  22  src/api      ts
   8  api          py
   2  api          pyi
```

Map the extensions to languages using this table:

| Extensions                          | Language       | Guide File        |
|------------------------------------|----------------|-------------------|
| `.ts`, `.tsx`, `.mts`, `.cts`      | typescript     | `typescript.md`   |
| `.js`, `.jsx`, `.mjs`, `.cjs`     | javascript     | `typescript.md`   |
| `.py`, `.pyi`                      | python         | `python.md`       |
| `.go`                              | go             | `go.md`           |
| `.rs`                              | rust           | `rust.md`         |
| `.java`                            | java           | `java.md`         |
| `.kt`, `.kts`                     | kotlin         | `java.md`         |
| `.rb`, `.rake`, `.erb`            | ruby           | `ruby.md`         |
| `.php`, `.blade.php`              | php            | `php.md`          |
| `.cs`                              | csharp         | `csharp.md`       |
| `.swift`                           | swift          | `swift.md`        |
| `.ex`, `.exs`, `.heex`            | elixir         | `elixir.md`       |
| `.dart`                            | dart           | `dart.md`         |
| `.c`, `.h`                         | c              | `c_cpp.md`        |
| `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh` | cpp         | `c_cpp.md`        |
| `.scala`, `.sc`                    | scala          | `scala.md`        |
| `.yml`, `.yaml`, `.toml`, `.json`, `.env*`, `Dockerfile*` | config | `infrastructure.md` |
| `.md`, `.rst`, `.txt`             | docs           | (documentation checks) |
| `.sh`, `.bash`, `.zsh`            | shell          | `general.md`      |
| `.sql`                             | sql            | `general.md`      |
| anything else                      | (language name)| `general.md`      |

**This is the key step.** Each directory gets tagged with its actual languages,
and those languages determine which guide files are passed to its sub-agent.
A directory with only `.py` files gets ONLY `python.md` — not typescript, not
rust, not everything.

### Step 0g: Write Detection Report

Create `sdlc-audit/modules/` and `sdlc-audit/data/` directories and write `sdlc-audit/data/detection.json`:

```json
{
  "primary_languages": ["typescript", "python"],
  "secondary_languages": ["bash", "sql", "yaml", "markdown"],
  "frameworks": {
    "typescript": ["next.js", "prisma"],
    "python": ["fastapi", "sqlalchemy"]
  },
  "tooling": {
    "linters": ["eslint", "ruff"],
    "formatters": ["prettier", "black"],
    "testing": ["jest", "pytest"],
    "ci": "github-actions",
    "containers": "docker",
    "iac": "terraform",
    "pre_commit": "husky"
  },
  "monorepo": false,
  "package_managers": { "js": "pnpm", "python": "poetry" },
  "total_source_files": 342,
  "total_directories": 48,
  "all_directories": {
    "src/auth/": {
      "category": "source",
      "est_files": 12,
      "languages": ["typescript"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md"]
    },
    "src/api/": {
      "category": "source",
      "est_files": 24,
      "languages": ["typescript"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md"]
    },
    "src/utils/": {
      "category": "source",
      "est_files": 8,
      "languages": ["typescript"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md"]
    },
    "src/db/": {
      "category": "source",
      "est_files": 15,
      "languages": ["typescript", "sql"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md", "${CLAUDE_PLUGIN_ROOT}/lang/general.md"]
    },
    "src/components/": {
      "category": "source",
      "est_files": 35,
      "languages": ["typescript"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md"]
    },
    "api/": {
      "category": "source",
      "est_files": 20,
      "languages": ["python"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/python.md"]
    },
    "tests/unit/": {
      "category": "tests",
      "est_files": 20,
      "languages": ["typescript", "python"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md", "${CLAUDE_PLUGIN_ROOT}/lang/python.md"]
    },
    "tests/integration/": {
      "category": "tests",
      "est_files": 10,
      "languages": ["typescript"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md"]
    },
    "scripts/": {
      "category": "scripts",
      "est_files": 5,
      "languages": ["bash", "python"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/python.md", "${CLAUDE_PLUGIN_ROOT}/lang/general.md"]
    },
    "docs/": {
      "category": "docs",
      "est_files": 8,
      "languages": ["markdown"],
      "guide_files": []
    },
    ".github/workflows/": {
      "category": "ci_cd",
      "est_files": 4,
      "languages": ["yaml"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/infrastructure.md"]
    },
    "infra/terraform/": {
      "category": "infrastructure",
      "est_files": 12,
      "languages": ["hcl"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/infrastructure.md"]
    },
    "prisma/": {
      "category": "database",
      "est_files": 3,
      "languages": ["prisma"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/infrastructure.md"]
    },
    "_root_": {
      "category": "config",
      "est_files": 15,
      "languages": ["json", "yaml", "toml", "markdown"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/infrastructure.md"]
    }
  }
}
```

**Critical rules:**
- The `all_directories` map must be EXHAUSTIVE — every single directory
  (except generated/vendored) must appear with category, languages, AND guide_files.
- `languages` is determined by the actual file extensions found in Step 0f — NOT
  by guessing from the project-level language list.
- `guide_files` is resolved from the `languages` field using the mapping in Step 0c.
- A directory with only `.py` files gets only `python.md`. A directory with `.ts`
  and `.sql` files gets `typescript.md` + `general.md`. Config directories always
  get `infrastructure.md`.
- Empty `guide_files` is valid for docs-only directories (they get documentation
  completeness checks, not language-specific code analysis).

---

### Progress: Report Phase 0 Results

After Phase 0 completes, report to the user:

> **Discovery complete.** Found:
> - [X] languages: [list them]
> - [Y] frameworks: [list them]
> - [Z] directories to analyze
> - Estimated [N] sub-agents needed
>
> Starting pre-analysis...

---

## Phase 0.5: Pre-Analysis (Programmatic)

These steps use fast, deterministic tools to gather data before sub-agents run.
Check `sdlc-audit/data/tool-availability.json` before each step — only run tools
that are available. Skip unavailable tools silently (the sub-agents will still
work without the pre-analysis data, just slower).

### Step 0h: Code Metrics

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

### Step 0i: Git History Analysis

**Only if `.git` directory exists.** Run the git analysis script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/git-analysis.sh .
```

This produces `sdlc-audit/data/git-hotspots.txt` and `sdlc-audit/data/git-busfactor.txt`.

**If `.git` does not exist:** Skip entirely. Note in detection.json: `"git_available": false`.

The hotspot data feeds into Phase 2i risk scoring. Files changed frequently
are higher risk.

### Step 0k: Run Existing Linters

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
=== LINTER RESULTS (from repo's own tools) ===
[filtered linter output for files in this sub-agent's directories]
=== END LINTER RESULTS ===

Do NOT re-report issues already captured by linters unless you have additional
context. Focus on: architectural concerns, semantic bugs, cross-file patterns,
DRY violations, and issues that require understanding intent.
```

### Step 0l: Type Checking

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
=== TYPE CHECK RESULTS ===
[filtered type errors for files in this sub-agent's directories]
=== END TYPE CHECK ===

Type errors from the compiler are authoritative. Analyze whether they reveal
deeper design problems or patterns (e.g., same type mismatch in 20 places
= missing abstraction).
```

### Step 0m: Dependency Vulnerability Audit

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

### Step 0j: Pattern Pre-Scan

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
=== PRE-SCAN FINDINGS (grep-detected patterns in your directories) ===
[filtered prescan results for this sub-agent's directories only]
=== END PRE-SCAN ===
```

This helps sub-agents focus on UNDERSTANDING issues rather than FINDING them.

### Step 0n: Extract Code Skeletons (Deterministic)

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
```bash
# For Rust, Ruby, PHP, C#, Swift, Elixir, Dart, Scala, C/C++
# Extract public function/method signatures
```

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

### Progress: Report Phase 0.5 Results

After pre-analysis completes, report to the user:

> **Pre-analysis complete:**
> - Code metrics: [collected / skipped (cloc not installed)]
> - Git history: [collected / skipped (not a git repo)]
> - Pattern pre-scan: found [N] pattern matches across [M] files
> - Code skeletons: [extracted for N files / skipped]
>
> Spawning [N] sub-agents for deep analysis (~3-10 minutes)...

---

## Phase 1: Exhaustive Directory Scan (Sub-Agents)

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

### Directory Classification

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

### Sub-Agent Assignment Plan

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

Sub-Agent 3: src/components/
  languages: [typescript]
  guides: [typescript.md]
  ~35 files

Sub-Agent 4: src/utils/, src/lib/, src/types/
  languages: [typescript]
  guides: [typescript.md]
  ~15 files

Sub-Agent 5: src/db/, prisma/
  languages: [typescript, sql, prisma]
  guides: [typescript.md, infrastructure.md]
  ~18 files

Sub-Agent 6: api/
  languages: [python]
  guides: [python.md]
  ~20 files

Sub-Agent 7: tests/unit/, tests/integration/
  languages: [typescript, python]
  guides: [typescript.md, python.md]
  ~30 files

Sub-Agent 8: scripts/, tools/
  languages: [bash, python]
  guides: [python.md, general.md]
  ~8 files

Sub-Agent 9: .github/workflows/, infra/terraform/
  languages: [yaml, hcl]
  guides: [infrastructure.md]
  ~16 files

Sub-Agent 10: Root config files
  languages: [json, yaml, toml, markdown]
  guides: [infrastructure.md]
  ~15 files

Sub-Agent 11: docs/
  languages: [markdown]
  guides: []  (documentation completeness checks only)
  ~8 files
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

### Sub-Agent Task Template

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
          "category": "security | performance | maintainability | dry | consistency | correctness | testing | documentation",
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
      "category": "maintainability",
      "description": "module-wide concern"
    }
  ],
  "test_coverage": "full | partial | none | not-applicable",
  "documentation_quality": "comprehensive | adequate | sparse | missing"
}
```

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

---

### Progress: Report Phase 1 Results

After all sub-agents complete, report to the user:

> **Deep analysis complete.** All [N] sub-agents finished.
> - Analyzed [X] files across [Y] directories
> - Found [Z] issues ([A] critical, [B] warning, [C] info)
>
> Running cross-module analysis...

---

## Phase 1.5: Variant Analysis

After all sub-agents complete, extract high-severity issues and search for
the same patterns across the entire repo. Bugs tend to be copy-pasted or
follow recurring patterns — finding one usually means there are more.

### Step 1: Extract Issue Patterns

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/extract-variants.sh .
```

**If jq is NOT available:** The script exits gracefully. Manually read each
module JSON, extract critical/warning issues, and group by `guide_rule` to
identify patterns.

### Step 2: Search for Variants of Single-Occurrence Critical Issues

Read `sdlc-audit/data/variant-candidates.json`. For each entry in `single_critical`:

1. Read the original issue's description and the affected file
2. Derive a grep-able pattern from the issue. Examples:
   - "SQL string concatenation" → search for string interpolation in SQL contexts
   - "Unvalidated user input" → search for request parameters used without validation
   - "Hardcoded credentials" → search for password/secret/token string literals
   - "Missing error handling" → search for unchecked promise/error patterns
3. Use Claude Code's Grep tool to search for the pattern across the repo
4. Any new matches are additional findings to add to the analysis

### Step 3: Flag Systemic Patterns

For entries in `systemic_patterns` (same pattern in 3+ modules):
- These represent codebase-wide anti-patterns, not isolated issues
- They should be reported as systemic findings in the AUDIT_REPORT.md
- Include a recommendation for a codebase-wide fix (e.g., "Create a parameterized
  query helper" rather than "Fix this one query")

### Step 4: Write Variant Analysis Output

Write `sdlc-audit/data/variant-analysis.json`:
```json
{
  "systemic_patterns": [
    {
      "pattern": "Unparameterized SQL queries",
      "guide_rule": "SQL/NoSQL injection via string concatenation",
      "occurrences": 7,
      "files": ["src/api/users.ts:45", "src/api/orders.ts:78"],
      "severity": "critical",
      "recommendation": "Create a parameterized query helper and migrate all raw SQL"
    }
  ],
  "variant_search_results": [
    {
      "original_finding": {"file": "src/api/users.ts", "issue": "SQL injection"},
      "new_matches": [
        {"file": "src/api/admin.ts", "line": 92, "match": "...matched text..."}
      ]
    }
  ]
}
```

### Progress: Report Phase 1.5 Results

> **Variant analysis complete:**
> - [N] systemic patterns found (same issue across 3+ modules)
> - [M] new variant instances discovered from targeted searches
>
> Running cross-module analysis...

---

## Phase 2: Cross-Module Analysis

Once ALL sub-agent JSON files are written to `sdlc-audit/modules/`,
Phase 2 runs in two stages: **programmatic analysis** (scripts), then
**parallel LLM agents** for judgment-based work.

### Stage 1: Programmatic Analysis (run sequentially)

Run these scripts first — they produce data files the LLM agents need.

#### 2a: Dependency Graph

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/build-dep-graph.sh .
```

**If jq is NOT available:** The script exits gracefully. Fall back to LLM
analysis of the module JSONs (read each one and manually build the graph).

#### 2b: Risk Scoring

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/compute-risk-scores.sh .
```

**If jq is NOT available:** Compute risk scores manually using the formula:
- **Blast radius** = fan-in (from dependency-data.json or internal_dependencies count)
- **Complexity** = lines + issue count + high-complexity function count
- **Safety net** = test coverage score + documentation quality score
- **Risk score** = (blast_radius × complexity) / safety_net

#### 2c: Incorporate Variant Analysis

Read `sdlc-audit/data/variant-analysis.json` (if it exists from Phase 1.5).
- Merge `variant_search_results` new matches into the relevant module findings
- Systemic patterns feed into the AUDIT_REPORT.md Systemic Patterns section
- Adjust risk scores upward for modules with systemic pattern involvement

### Stage 2: Parallel Cross-Module Agents

Spawn these agents in parallel using Claude Code's Task tool. Each agent reads
ALL module JSONs from `sdlc-audit/modules/` plus the programmatic data files.
Each agent writes its findings as a JSON file to `sdlc-audit/data/`.

**Important:** Each agent works on an independent concern. They read shared
data but write to separate output files, so there are no conflicts.

#### Agent: DRY Violations

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
      "suggestion": "how to centralize"
    }
  ]
}
```

#### Agent: Inconsistencies

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
      "recommendation": "which approach to standardize on and why"
    }
  ]
}
```

#### Agent: Architecture

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
- Layering violations (UI → DB, tests → production coupling)
- Missing abstraction boundaries between features
- Feature coupling (one feature's internals imported by another)

Infrastructure ↔ Code alignment:
- CI/CD covers all code paths (tests, lint, build, deploy)
- Docker setup matches actual dependencies
- Environment variables in code ↔ .env.example ↔ CI secrets
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

Language-specific cross-module checks:
- Apply the "Cross-Module Checks" section from each detected language's
  guide file (read from sdlc-audit/guides/).

Write findings to sdlc-audit/data/cross-module-architecture.json:
{
  "architecture_issues": [
    {
      "type": "god_module | layering | coupling | infra_mismatch | other",
      "description": "what is wrong",
      "modules": ["affected", "modules"],
      "severity": "critical | warning",
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

#### Agent: Test & Documentation Coverage

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

### Progress: Report Phase 2 Results

After all scripts and agents complete, report to the user:

> **Cross-module analysis complete.** Found:
> - [N] cross-module issues (DRY violations, inconsistencies, architecture concerns)
> - Dependency cycles: [count or "none"]
> - Highest-risk modules: [top 3 by risk score]
>
> Generating reports...

---

## Phase 3: Generate Output

All output files go inside `sdlc-audit/`. Do NOT create files anywhere else.

Phase 3 runs in two stages: **assembly scripts** (fast, deterministic) generate
the quantitative reports, then **parallel LLM agents** handle synthesis tasks
that require judgment.

### Stage 1: Assembly Scripts

Run all 5 scripts. They read module JSONs and data files, then produce
complete markdown reports. These can run in parallel (no dependencies between them).

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/assemble-audit-report.sh .
bash ${CLAUDE_PLUGIN_ROOT}/scripts/assemble-project-map.sh .
bash ${CLAUDE_PLUGIN_ROOT}/scripts/assemble-tech-debt.sh .
bash ${CLAUDE_PLUGIN_ROOT}/scripts/assemble-test-coverage.sh .
bash ${CLAUDE_PLUGIN_ROOT}/scripts/assemble-dep-graph.sh .
```

Each script exits gracefully if jq is not available. If a script skips,
fall back to LLM-generated content for that report (see fallback section below).

**After scripts run**, verify which reports were created:
- `sdlc-audit/reports/AUDIT_REPORT.md`
- `sdlc-audit/reports/PROJECT_MAP.md`
- `sdlc-audit/reports/TECH_DEBT.md`
- `sdlc-audit/reports/TEST_COVERAGE_MAP.md`
- `sdlc-audit/reports/DEPENDENCY_GRAPH.md`

### Stage 2: Parallel LLM Agents (Synthesis)

Spawn these agents in parallel using Claude Code's Task tool. They handle
the tasks that require LLM judgment — pattern recognition, convention
synthesis, and qualitative interpretation.

#### Agent: Patterns

Writes `sdlc-audit/reports/PATTERNS.md`. Reads all module JSONs and
cross-module data files.

```
You are a codebase patterns analyzer.

Read ALL JSON files in sdlc-audit/modules/ and sdlc-audit/data/cross-module-*.json.

Write sdlc-audit/reports/PATTERNS.md documenting every discovered convention
(good and problematic):

- Naming conventions (per language, per module)
- Error handling patterns
- Testing patterns
- State management
- API design
- File organization
- Auth patterns
- Logging conventions
- Config management

For each pattern, note:
- Where it appears (which modules/files)
- Whether it's consistently applied
- Whether it's a good practice or an anti-pattern
- Recommended standardization (if inconsistent)

End with a footer: ---\n*Generated by repo-audit*
```

#### Agent: CLAUDE.md

Writes `sdlc-audit/staged/CLAUDE.md`. Reads module JSONs, patterns data,
and cross-module analysis.

```
You are a CLAUDE.md convention synthesizer.

Read ALL JSON files in sdlc-audit/modules/ and sdlc-audit/data/cross-module-*.json.
Also read sdlc-audit/data/detection.json for project structure.

Write sdlc-audit/staged/CLAUDE.md with proposed conventions for this project.

IMPORTANT: Do NOT modify the project's existing CLAUDE.md. Write ONLY to
sdlc-audit/staged/CLAUDE.md.

Format:

# Proposed CLAUDE.md Updates
# Generated by repo-audit on [DATE]
#
# Review the content below and copy what you want into your project's CLAUDE.md.
# To apply: copy desired sections into your CLAUDE.md at the project root.

## Codebase Orientation
Read sdlc-audit/reports/PROJECT_MAP.md for full codebase orientation.

## Discovered Conventions
[Naming, error handling, testing, async patterns, etc.]

## Anti-Patterns to Avoid
[Specific patterns found in this codebase that should not be repeated]

## Key Architectural Decisions
[Major design choices discovered during the audit]

## Per-Directory Conventions
### [directory]/
[Conventions specific to this directory]
[... for each major directory]

## Testing Conventions
[Testing patterns, frameworks, file organization]

## Error Handling Conventions
[Error handling approach used in this codebase]
```

#### Agent: Report Enrichment

Reads the script-generated reports and cross-module data, then appends
qualitative commentary where the scripts left quantitative-only output.

```
You are a report enrichment agent.

Read the following script-generated reports (if they exist):
- sdlc-audit/reports/AUDIT_REPORT.md
- sdlc-audit/reports/PROJECT_MAP.md
- sdlc-audit/reports/TECH_DEBT.md
- sdlc-audit/reports/TEST_COVERAGE_MAP.md
- sdlc-audit/reports/DEPENDENCY_GRAPH.md

Also read:
- sdlc-audit/data/cross-module-architecture.json (architecture analysis)
- sdlc-audit/data/cross-module-dry.json (DRY violations)
- sdlc-audit/data/cross-module-inconsistencies.json (inconsistencies)
- sdlc-audit/data/cross-module-coverage.json (coverage gaps)

For each report that exists, append a ## Cross-Module Analysis section
(before the footer) with relevant findings from the cross-module data:

AUDIT_REPORT.md:
- Append cross-module DRY violations, inconsistencies, architecture issues
  as additional findings (use same severity/category format)

PROJECT_MAP.md:
- No changes needed (already comprehensive from the script)

TECH_DEBT.md:
- Append DRY violations to Strategic Improvements
- Append architecture issues to Major Refactors

TEST_COVERAGE_MAP.md:
- Append coverage gap analysis and priority recommendations

DEPENDENCY_GRAPH.md:
- Append dependency interpretation from architecture agent
  (problematic cycles, hub assessments, decoupling suggestions)
- Append duplicate external dependency analysis

IMPORTANT: When editing reports, ADD sections before the --- footer line.
Do not overwrite or reformat existing script-generated content.
```

### Stage 1 Fallback (no jq)

If any assembly script was skipped (jq not available), the corresponding
report must be generated by LLM instead. Check which reports are missing
after Stage 1 and generate them manually following these specifications:

**AUDIT_REPORT.md**: Read all module JSONs. Create severity summary table,
tool results table, systemic patterns, type errors, dependency vulnerabilities,
then findings grouped by severity then category.

**PROJECT_MAP.md**: Read detection.json, metrics.json, git data, module JSONs.
Create languages, frameworks, code metrics table, directory structure,
module dependencies, git activity, module purposes.

**TECH_DEBT.md**: Read module JSONs and tool output. Create quick wins
(linter violations with auto-fix commands), strategic improvements,
major refactors, risk-weighted priorities.

**TEST_COVERAGE_MAP.md**: Read module JSONs and risk scores. Create coverage
table, untested modules, critical untested paths, partially tested modules,
testing issues.

**DEPENDENCY_GRAPH.md**: Read dependency-data.json. Create internal dependency
map, circular dependencies, hub modules, orphan modules, external dependency
inventory, shared dependencies.

### Report Footers

The assembly scripts already include `*Generated by repo-audit*` footers.
The LLM-generated reports (PATTERNS.md, staged/CLAUDE.md) should also end with:

```markdown
---
*Generated by repo-audit*
```

### Audit Metadata

After generating all reports, write audit metadata to enable incremental mode:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/write-audit-meta.sh . full [module1] [module2] ...
```

Replace `full` with `incremental` if incremental mode was used. Pass the list of
module directory names that were actually analyzed as trailing arguments.

### Data Surfacing Rules

When generating reports, follow these rules:
1. **If a data file exists, include its section.** If it doesn't exist (tool
   wasn't available or step was skipped), omit the section entirely.
2. **Never fabricate tool output.** Only include data sourced from actual files.
3. **Link to raw data.** For each tool result section, include the path to the
   raw data file so users can inspect it themselves.

---

## Phase 4: Review and Apply

After all reports are generated, present this summary to the user:

---

**Audit complete!** All results are contained in `sdlc-audit/`.

No files in your repository were modified.

**Reports** (read-only analysis):
- `sdlc-audit/reports/AUDIT_REPORT.md` — Start here. [X] findings by severity.
- `sdlc-audit/reports/TECH_DEBT.md` — Prioritized backlog with effort estimates.
- `sdlc-audit/reports/PROJECT_MAP.md` — Full codebase orientation guide.
- `sdlc-audit/reports/PATTERNS.md` — Discovered conventions and anti-patterns.
- `sdlc-audit/reports/DEPENDENCY_GRAPH.md` — Module dependency map.
- `sdlc-audit/reports/TEST_COVERAGE_MAP.md` — Per-module test assessment.

**Staged changes** (your choice to apply):
- `sdlc-audit/staged/CLAUDE.md` — Proposed conventions for your CLAUDE.md.
  Review it and copy the sections you want into your project's CLAUDE.md.

**Clean up:** `rm -rf sdlc-audit/` removes everything with zero side effects.
**Keep for reference:** Consider adding `sdlc-audit/` to your `.gitignore`.

Would you like me to walk through the findings, or would you prefer to
review the reports on your own?

---

Do NOT automatically apply any staged changes. The user reviews and decides
what to adopt. Only help apply changes if the user explicitly asks.

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

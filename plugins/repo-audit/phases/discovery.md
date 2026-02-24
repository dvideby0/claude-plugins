# Phase 0: Discovery

## Step 0-pre: Prerequisites Check

Run the prerequisite checker via the `audit_discover` MCP tool, which
detects available tools on the user's system and writes
`sdlc-audit/data/tool-availability.json`.

**If there are missing optional tools** (rg, tree, cloc, etc.), notify the user
using `AskUserQuestion`. Build the question dynamically from the JSON data:

- List each missing tool by name with a brief description of what it enables
- Include the combined install command from `install_commands.all_missing`
- Present the user with these options:
  1. **"Install and re-check"** — The user will install the tools themselves.
     After they select this, re-run discovery to refresh
     `tool-availability.json`, then continue with the updated availability.
  2. **"Proceed without them"** — Continue the audit without these optional
     tools. The audit still works, but will be slower and less thorough for
     the affected checks.

Example question format:
> "The following optional tools are missing: **rg** (fast pattern scanning),
> **tree** (directory visualization). These make the audit faster and more
> thorough. To install, run: `brew install ripgrep && brew install tree`.
> How would you like to proceed?"

**If all tools are available**, skip the prompt and continue immediately.

Throughout all subsequent phases, check `tool-availability.json` before using
any optional tool. If a tool is not available, skip the optimization.

## Step 0a: Full Directory Map
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

## Step 0b: Language Detection via Manifests

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

Manifest to Language mapping:

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

## Step 0c: Language to Guide File Mapping
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

## Step 0d: Framework Detection
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

## Step 0e: Tooling Detection

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

## Step 0f: Per-Directory Language Scan

Scan ALL directories in a single pass to determine which languages are present
in each directory. Do NOT run a separate command per directory:

Run as a single bash command (all on one line — do NOT split across multiple lines):
```bash
find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/__pycache__/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/.next/*' -not -path '*/target/*' -not -path '*/obj/*' -not -path '*/.gradle/*' -not -path '*/Pods/*' -not -path '*/coverage/*' -not -path '*/sdlc-audit/*' | awk -F/ '{dir=""; for(i=1;i<NF;i++) dir=dir (i>1?"/":"") $i; if(dir=="") dir="."; n=split($NF,p,"."); ext=(n>1)?p[n]:"none"; print dir "\t" ext}' | sort | uniq -c | sort -rn
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

## Step 0g: Write Detection Report

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
    "tests/unit/": {
      "category": "tests",
      "est_files": 20,
      "languages": ["typescript", "python"],
      "guide_files": ["${CLAUDE_PLUGIN_ROOT}/lang/typescript.md", "${CLAUDE_PLUGIN_ROOT}/lang/python.md"]
    },
    ".github/workflows/": {
      "category": "ci_cd",
      "est_files": 4,
      "languages": ["yaml"],
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

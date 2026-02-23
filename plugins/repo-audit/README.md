# repo-audit — Claude Code Plugin

A comprehensive, language-aware codebase audit plugin for Claude Code.
Auto-detects your languages and frameworks, runs your existing tools,
spawns per-module sub-agents, and generates actionable reports — all
without touching a single line of your code.

## Install

```
/plugin install repo-audit
```

The `/audit` command is now available in Claude Code.

## Quick Start

```
/audit
```

Runs a full repository audit. You'll be asked to confirm before it starts.
Takes 5-15 minutes depending on repo size. All output goes to `sdlc-audit/`.

Or with the plugin namespace (if you have a naming conflict):

```
/repo-audit:audit
```

## Is It Safe?

Yes. The audit is **completely non-destructive**:

- Does **NOT** modify any of your source code, config files, or documentation
- Does **NOT** delete any existing files
- Does **NOT** commit anything to git or push to any remote
- Does **NOT** install packages or change your dependencies
- Does **NOT** modify your CLAUDE.md (proposes changes for you to review instead)

**Everything** the audit produces goes into a single `sdlc-audit/` directory.
To completely undo: `rm -rf sdlc-audit/` — zero side effects.

## What Happens When You Run /audit

1. **Prerequisite check** — Detects available tools on your system. Shows what's
   installed, what's missing, and how to install missing tools for your OS. The
   audit works without optional tools but is more thorough with them.
2. **Confirmation** — Explains what the audit will do and asks you to confirm.
   If a previous audit exists, offers incremental mode.
3. **Discovery** (~30s) — Single-pass scan of your directory structure. Detects
   languages, frameworks, and tooling from manifests and file extensions.
4. **Pre-analysis** (~1-2min) — Runs your existing linters (eslint, ruff, etc.),
   type checkers (tsc, mypy, go vet), dependency audit tools (npm audit, pip-audit),
   code metrics (cloc/tokei), git history analysis, and pattern pre-scans. Only
   runs tools you already have installed.
5. **Code skeletons** — Extracts imports, exports, and function signatures using
   deterministic tools (Python AST, grep) so sub-agents can focus on judgment, not parsing.
6. **Deep analysis** (~3-10min) — Spawns parallel sub-agents, each analyzing a
   section of your codebase with language-specific expertise and pre-analysis results.
7. **Variant analysis** — Takes the highest-severity findings and systematically
   searches for the same patterns across your entire repo.
8. **Cross-reference** (~1-2min) — Scripts build the dependency graph and risk scores,
   then parallel LLM agents analyze DRY violations, inconsistencies, and architecture.
9. **Reports** (~30s) — Assembly scripts (bash+jq) generate 5 quantitative reports in
   parallel, then LLM agents synthesize PATTERNS.md, staged CLAUDE.md, and add
   qualitative commentary to the script-generated reports.
10. **Review** — Presents a summary and lets you decide what (if anything) to apply.

Estimated total time: **5-15 minutes** depending on repo size.

## What It Does

1. **Auto-detects** your languages, frameworks, and tooling from manifests and file extensions
2. **Runs your tools** — leverages linters, type checkers, and audit tools you already have configured
3. **Classifies every directory** (source, tests, scripts, config, CI/CD, infra, docs, database)
4. **Scans each directory** for actual languages present (per-directory, not project-level guessing)
5. **Extracts code skeletons** — deterministic import/export/signature extraction via AST and grep
6. **Spawns sub-agents** per module — each reads all files in its scope with only the relevant language guide
7. **Hunts for variants** — finds one bug, then searches for siblings across the entire repo
8. **Builds dependency graph** programmatically with cycle detection and hub/orphan classification
9. **Computes risk scores** using formula: (blast_radius x complexity) / safety_net
10. **Generates reports** and **stages** proposed CLAUDE.md conventions for your review

## Output

All output is contained in a single directory at your project root:

```
sdlc-audit/
├── reports/                         # Human-readable reports
│   ├── AUDIT_REPORT.md              # All findings by severity — start here
│   ├── PROJECT_MAP.md               # Annotated directory tree + code metrics
│   ├── PATTERNS.md                  # Discovered conventions and anti-patterns
│   ├── TECH_DEBT.md                 # Prioritized backlog with effort estimates
│   ├── DEPENDENCY_GRAPH.md          # Module dependency map with cycle detection
│   └── TEST_COVERAGE_MAP.md         # Per-module test assessment
│
├── staged/                          # Proposed changes — your choice to apply
│   └── CLAUDE.md                    # Proposed conventions for your CLAUDE.md
│
├── data/                            # Machine-readable analysis data
│   ├── detection.json               # Detected languages, frameworks, tooling
│   ├── tool-availability.json       # Tools available on your system
│   ├── metrics.json                 # Code metrics from cloc/tokei
│   ├── git-hotspots.txt             # Most-changed files (last 6 months)
│   ├── git-busfactor.txt            # Contributors per module
│   ├── dependency-data.json         # Programmatic dependency graph
│   ├── risk-scores.json             # Per-module risk scores
│   ├── variant-analysis.json        # Systemic pattern detection
│   ├── variant-candidates.json      # Issue patterns extracted for variant search
│   ├── .audit-meta.json             # Audit metadata (enables incremental mode)
│   └── skeletons/                   # Deterministic code structure extraction
│       ├── python.json
│       ├── typescript.json
│       └── ...
│
├── tool-output/                     # Raw output from your repo's tools
│   ├── linter-results/              # eslint, ruff, biome, etc.
│   ├── typecheck/                   # tsc, go vet, cargo check
│   └── deps/                        # npm audit, pip-audit, cargo audit
│
├── prescan/                         # Pattern pre-scan results
│   └── prescan-summary.txt          # Grep-detected patterns and counts
│
└── modules/                         # Detailed per-module analysis JSON
    ├── src_auth.json
    ├── src_api.json
    └── ...
```

**Where to start:** `sdlc-audit/reports/AUDIT_REPORT.md`

**Who should read what:**

| Report | Best for |
|--------|----------|
| AUDIT_REPORT.md | Everyone — all findings by severity |
| TECH_DEBT.md | Sprint planning — prioritized backlog |
| PROJECT_MAP.md | New team members — codebase orientation |
| PATTERNS.md | Code review standards — team conventions |
| DEPENDENCY_GRAPH.md | Tech leads — architecture overview |

**Staged changes:** Review `sdlc-audit/staged/CLAUDE.md` and copy the sections
you want into your project's CLAUDE.md. Nothing is applied automatically.

**Clean up:** `rm -rf sdlc-audit/` or add `sdlc-audit/` to your `.gitignore`.

## Incremental Mode

When you run `/audit` and a previous audit exists, you'll be offered:

- **Incremental audit** — Only re-analyzes files changed since the last audit
  and their dependents (modules that import from changed modules). Faster for
  follow-up audits after fixing issues.
- **Full audit** — Starts fresh, overwriting all previous results.

Incremental mode still runs full cross-module analysis and regenerates all reports
to ensure they reflect the complete picture.

## Optional Prerequisites

The audit works **out of the box with zero dependencies**. Installing optional
tools makes it faster and more thorough. The prerequisite checker runs
automatically and tells you exactly what to install.

**Core enhancements:**

| Tool | What It Improves | Install (macOS) | Install (Linux) |
|------|-----------------|-----------------|-----------------|
| jq | Dependency graph processing | `brew install jq` | `apt install jq` |
| ripgrep | Fast pattern pre-scanning | `brew install ripgrep` | `apt install ripgrep` |
| tree | Directory visualization | `brew install tree` | `apt install tree` |
| cloc | Accurate code metrics | `brew install cloc` | `apt install cloc` |

**Language-specific** (only relevant if you use that language):

| Tool | Language | What It Improves | Install |
|------|----------|-----------------|---------|
| pip-audit | Python | Dependency vulnerability scanning | `pip install pip-audit` |
| cargo-audit | Rust | Dependency vulnerability scanning | `cargo install cargo-audit` |
| govulncheck | Go | Dependency vulnerability scanning | `go install golang.org/x/vuln/cmd/govulncheck@latest` |
| bundle-audit | Ruby | Dependency vulnerability scanning | `gem install bundler-audit` |

The prerequisite checker detects your OS and provides the correct install
commands for your package manager (brew, apt, dnf, pacman, apk).

## Supported Languages

Each has a dedicated analysis guide with framework-specific checks:

| Language       | Guide              | Frameworks                                           |
|--------------- |-------------------- |------------------------------------------------------|
| TypeScript/JS  | `typescript.md`     | React, Next.js, Node.js, Express, NestJS, Angular    |
| Python         | `python.md`         | Django, FastAPI, Flask, pandas/numpy, SQLAlchemy      |
| Go             | `go.md`             | Gin, Echo, Chi, Fiber, GORM                          |
| Rust           | `rust.md`           | Actix, Axum, Tokio, Diesel, SeaORM                   |
| Java/Kotlin    | `java.md`           | Spring Boot, JPA/Hibernate, Kotlin coroutines         |
| Ruby           | `ruby.md`           | Rails, RSpec, Sidekiq, Sinatra                        |
| C#/.NET        | `csharp.md`         | ASP.NET Core, Entity Framework, xUnit                 |
| PHP            | `php.md`            | Laravel, Symfony, PHPUnit                             |
| Swift          | `swift.md`          | SwiftUI, UIKit, Swift Concurrency                     |
| C/C++          | `c_cpp.md`          | CMake, sanitizers, memory safety                      |
| Elixir         | `elixir.md`         | Phoenix, Ecto, OTP, LiveView                          |
| Dart/Flutter   | `dart.md`           | Flutter, Riverpod, BLoC                               |
| Scala          | `scala.md`          | Play Framework, Akka, Cats Effect, ZIO                |
| Infrastructure | `infrastructure.md` | Docker, CI/CD, IaC, secrets, migrations               |
| General        | `general.md`        | Universal fallback for any other language              |

Multi-language repos get all applicable guides. A directory with `.py` files
gets only `python.md` — not every guide in the project.

## What Gets Analyzed

Everything except generated and vendored code:

| Category       | What's Checked                                |
|--------------- |-----------------------------------------------|
| Source code    | Full language-specific analysis               |
| Tests          | Quality, coverage, patterns                   |
| Scripts        | Correctness, security, maintainability        |
| Config         | Consistency, security, completeness           |
| CI/CD          | Coverage, security, alignment with code       |
| Infrastructure | Security, best practices, code alignment      |
| Database       | Migration safety, indexing, consistency        |
| Documentation  | Completeness, staleness, accuracy             |

## Architecture

```
Phase 0-pre: Prerequisites Check
  Detect OS, check available tools, report to user
       │
Phase 0: Discovery
  Single-pass manifest scan, extension census
  Per-directory language detection
  Output: sdlc-audit/data/detection.json
       │
Phase 0.5: Pre-Analysis (Deterministic)
  Code metrics (cloc/tokei)
  Git history analysis (hotspots, bus factor)
  Run existing linters (eslint, ruff, biome, clippy, etc.)
  Run type checkers (tsc, mypy, go vet, cargo check)
  Dependency vulnerability audit (npm/pip/cargo/go audit)
  Pattern pre-scan (grep for anti-patterns)
  AST-based code skeleton extraction
  Output: sdlc-audit/data/, sdlc-audit/tool-output/, sdlc-audit/prescan/
       │
Phase 1: Deep Analysis (Sub-Agents)
  Spawn parallel sub-agents per module
  Each receives: language guides + pre-analysis results + skeletons
  Output: sdlc-audit/modules/*.json
       │
Phase 1.5: Variant Analysis
  Extract recurring patterns from Phase 1 findings
  Search for variant instances across codebase
  Output: sdlc-audit/data/variant-analysis.json
       │
Phase 2: Cross-Module Analysis
  Stage 1: Programmatic (dependency graph, risk scoring via bash+jq)
  Stage 2: Parallel LLM agents (DRY, inconsistencies, architecture, coverage)
  Output: sdlc-audit/data/dependency-data.json, risk-scores.json, cross-module-*.json
       │
Phase 3: Reports
  Stage 1: Assembly scripts (5x bash+jq, run in parallel, seconds)
  Stage 2: Parallel LLM agents (PATTERNS.md, staged/CLAUDE.md, report enrichment)
  Output: sdlc-audit/reports/, sdlc-audit/staged/
       │
Phase 4: Review and Apply
  Present summary to user
  User decides what to adopt
```

## Adding a Language

Create a new `.md` file in the `lang/` directory following the pattern of
existing guides (File-Level Analysis + Framework-Specific + Cross-Module Checks).
Then add the manifest detection and extension mapping to the main command.

## Plugin Structure

```
repo-audit/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── commands/
│   └── audit.md             # Main /audit slash command (orchestrator)
├── scripts/
│   ├── check-prereqs.sh         # Prerequisite checker (detects tools, suggests installs)
│   ├── git-analysis.sh          # Git hotspot and bus factor analysis
│   ├── build-dep-graph.sh       # Dependency graph builder (bash + jq)
│   ├── compute-risk-scores.sh   # Per-module risk score calculator (bash + jq)
│   ├── extract-variants.sh      # Variant analysis pattern extractor (bash + jq)
│   ├── extract-skeletons.py     # Python AST skeleton extractor (only for Python projects)
│   ├── write-audit-meta.sh      # Audit metadata writer (pure bash)
│   ├── assemble-audit-report.sh # Report assembly: findings by severity (bash + jq)
│   ├── assemble-project-map.sh  # Report assembly: project map (bash + jq)
│   ├── assemble-tech-debt.sh    # Report assembly: tech debt backlog (bash + jq)
│   ├── assemble-test-coverage.sh # Report assembly: test coverage map (bash + jq)
│   └── assemble-dep-graph.sh    # Report assembly: dependency graph (bash + jq)
├── lang/
│   ├── typescript.md        # Language-specific audit guides
│   ├── python.md
│   ├── go.md
│   ├── rust.md
│   ├── java.md
│   ├── ruby.md
│   ├── php.md
│   ├── swift.md
│   ├── c_cpp.md
│   ├── csharp.md
│   ├── elixir.md
│   ├── dart.md
│   ├── scala.md
│   ├── infrastructure.md
│   └── general.md
├── README.md
└── LICENSE
```

## FAQ

**How long does it take?**
5-15 minutes depending on repo size.

**Will it modify my code?**
No. It only creates files inside `sdlc-audit/`. Your source code, config,
and existing files are never touched.

**What about CLAUDE.md?**
The audit proposes CLAUDE.md content in `sdlc-audit/staged/CLAUDE.md`. You
review it and copy what you want into your actual CLAUDE.md.

**Can I run it again?**
Yes. If a previous audit exists, you'll be offered incremental mode to only
re-analyze changed files, or you can run a full audit.

**How do I undo it?**
`rm -rf sdlc-audit/` — that's it. Nothing else was changed.

**Does it work on monorepos?**
Yes. Each package/service is treated as an independent audit unit, then
cross-analyzed.

**What if a sub-agent fails?**
The audit continues and notes incomplete coverage in the report.

**Do I need to install anything?**
No. The audit works out of the box. Optional tools (jq, cloc, ripgrep, etc.)
make it faster and more thorough. The prerequisite checker tells you exactly
what to install for your OS.

## License

MIT

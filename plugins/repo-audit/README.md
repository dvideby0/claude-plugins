# repo-audit — Claude Code Plugin

A comprehensive, language-aware codebase audit plugin for Claude Code.
Auto-detects your languages and frameworks, runs your existing tools,
spawns per-module sub-agents, and generates actionable reports — all
without touching a single line of your code.

## Install

```
/plugin install repo-audit
```

## Quick Start

**New to this plugin?** Start with the fast scan:

```
/audit-quick
```

Runs in 30-60 seconds using only deterministic tools (linters, type checkers,
dependency audits). No LLM agents — just your existing tooling.

**Ready for a full audit?**

```
/audit
```

Runs the complete multi-phase analysis with sub-agents, cross-module analysis,
and 6 detailed reports. Takes 5-15 minutes depending on repo size.

Or with the plugin namespace (if you have a naming conflict):

```
/repo-audit:audit
```

## Commands

| Command | What It Does | Time | Output |
|---------|-------------|------|--------|
| `/audit` | Full multi-phase audit — everything below, plus variant analysis and cross-module synthesis | 5-15 min | 6 reports + staged CLAUDE.md |
| `/audit-quick` | Fast deterministic-only scan — linters, type checkers, dependency audits, pattern pre-scans | 30-60 sec | QUICK_SCAN.md |
| `/audit-security` | Security-focused — secrets, CVEs, injection patterns, auth issues, OWASP Top 10 | 2-3 min | SECURITY_REPORT.md |
| `/audit-deps` | Dependency analysis — module graph, circular deps, hub/orphan modules, external CVEs | 1-2 min | DEPENDENCY_GRAPH.md |
| `/audit-arch` | Architecture review — god modules, layering violations, coupling, risk scoring | 3-5 min | ARCHITECTURE_REVIEW.md |
| `/audit-patterns` | Convention discovery — naming, error handling, testing patterns, CLAUDE.md generation | 2-3 min | PATTERNS.md + staged CLAUDE.md |
| `/audit-coverage` | Test coverage — per-module assessment, critical gaps, quality analysis | 2-3 min | TEST_COVERAGE_MAP.md |

**Sub-commands share work.** If you run `/audit-quick` first, subsequent commands
reuse the discovery data and tool output. Run `/audit` after sub-commands and it
reuses existing module analysis where available.

## Is It Safe?

Yes. Every command is **completely non-destructive**:

- Does **NOT** modify any of your source code, config files, or documentation
- Does **NOT** delete any existing files
- Does **NOT** commit anything to git or push to any remote
- Does **NOT** install packages or change your dependencies
- Does **NOT** modify your CLAUDE.md (proposes changes for you to review instead)

**Everything** the audit produces goes into a single `sdlc-audit/` directory.
To completely undo: `rm -rf sdlc-audit/` — zero side effects.

## What Happens When You Run /audit

1. **Prerequisite check** — Detects available tools on your system. Shows what's
   installed, what's missing, and how to install missing tools for your OS.
2. **Confirmation** — Explains what the audit will do, estimates time and scope,
   asks you to confirm. If a previous audit exists, offers incremental mode.
3. **Discovery** (~30s) — Single-pass scan of your directory structure. Detects
   languages, frameworks, and tooling from manifests and file extensions.
4. **Pre-analysis** (~1-2min) — Runs your existing linters (eslint, ruff, etc.),
   type checkers (tsc, mypy, go vet), dependency audit tools (npm audit, pip-audit),
   code metrics (cloc/tokei), git history analysis, and pattern pre-scans.
5. **Code skeletons** — Extracts imports, exports, and function signatures using
   deterministic tools (Python AST, grep-based extractors for TypeScript/JS, Go,
   Rust, and Java) so sub-agents can focus on judgment.
6. **Deep analysis** (~3-10min) — Spawns parallel sub-agents, each analyzing a
   section of your codebase with language-specific expertise and pre-analysis results.
7. **Variant analysis** — Takes the highest-severity findings and systematically
   searches for the same patterns across your entire repo.
8. **Cross-reference** (~1-2min) — Scripts build the dependency graph and risk scores,
   then parallel LLM agents analyze DRY violations, inconsistencies, and architecture.
9. **Reports** (~30s) — Assembly scripts (bash+jq) generate quantitative reports
   with placeholders, a second script fills cross-module data into those
   placeholders, then LLM agents synthesize PATTERNS.md and staged CLAUDE.md.
10. **Review** — Presents a summary dashboard and lets you decide what to apply.

**Progress reporting**: Every phase reports status as it completes. Sub-agent
progress is reported incrementally. You'll never see more than 30-60 seconds
of silence.

## Confidence Scoring

Every finding includes a confidence level so you can focus on what matters:

| Confidence | Source | What It Means |
|-----------|--------|--------------|
| **Definite** | Linters, type checkers, CVE databases | Facts from deterministic tools. Always accurate. |
| **High** | Pattern pre-scan (grep-based detection) | Pattern matched. Context might make it valid, but usually a real issue. |
| **Medium** | LLM sub-agent analysis | Code was read and analyzed with clear evidence cited. Requires judgment. |
| **Low** | Cross-module / architectural opinions | Subjective assessment. Worth considering but may not apply. |

Reports show a "high-confidence findings" summary at the top for quick triage.
Risk scoring weights issues by confidence (definite=1.0, high=0.8, medium=0.5,
low=0.2) so higher-confidence findings have more impact on a module's risk score.
All enum values are defined in `schemas/enums.json`.

## Output

All output is contained in a single directory at your project root:

```
sdlc-audit/
├── reports/                         # Human-readable reports
│   ├── AUDIT_REPORT.md              # All findings by severity — start here
│   ├── QUICK_SCAN.md                # Fast deterministic scan results
│   ├── SECURITY_REPORT.md           # Security-focused findings
│   ├── ARCHITECTURE_REVIEW.md       # Architecture analysis and risk scores
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
│   ├── validation-results.json     # Module JSON schema validation results
│   ├── cross-module-*.json         # Cross-module analysis (DRY, arch, etc.)
│   ├── .audit-meta.json             # Audit metadata (enables incremental mode)
│   └── skeletons/                   # Deterministic code structure extraction
│
├── tool-output/                     # Raw output from your repo's tools
│   ├── linter-results/              # eslint, ruff, biome, etc.
│   ├── typecheck/                   # tsc, go vet, cargo check
│   └── deps/                        # npm audit, pip-audit, cargo audit
│
├── prescan/                         # Pattern pre-scan results
│   └── prescan-summary.txt
│
└── modules/                         # Detailed per-module analysis JSON
    ├── src_auth.json
    └── ...
```

**Where to start:** `sdlc-audit/reports/AUDIT_REPORT.md` (full audit) or
`sdlc-audit/reports/QUICK_SCAN.md` (quick scan)

**Who should read what:**

| Report | Best for |
|--------|----------|
| QUICK_SCAN.md | Quick check — linter/type/CVE results in 60 seconds |
| AUDIT_REPORT.md | Everyone — all findings by severity with confidence |
| SECURITY_REPORT.md | Security review — secrets, CVEs, OWASP mapping |
| ARCHITECTURE_REVIEW.md | Tech leads — risk scores, god modules, coupling |
| TECH_DEBT.md | Sprint planning — prioritized backlog |
| PROJECT_MAP.md | New team members — codebase orientation |
| PATTERNS.md | Code review standards — team conventions |
| DEPENDENCY_GRAPH.md | Architecture — module graph and cycles |
| TEST_COVERAGE_MAP.md | QA — coverage gaps and priorities |

**Staged changes:** Review `sdlc-audit/staged/CLAUDE.md` and copy the sections
you want into your project's CLAUDE.md. Nothing is applied automatically.

**Clean up:** `rm -rf sdlc-audit/` or add `sdlc-audit/` to your `.gitignore`.

## Incremental Mode

When you run `/audit` and a previous audit exists, you'll be offered:

- **Incremental audit** — Only re-analyzes files changed since the last audit
  and their dependents (modules that import from changed modules).
- **Full audit** — Starts fresh, overwriting all previous results.

Incremental mode still runs full cross-module analysis and regenerates all reports.

The audit tracks the plugin version and a hash of the project structure in
`.audit-meta.json`. If either changes between runs, the incremental mode will
warn you that a full audit is recommended.

## Prerequisites

**Required:**

| Tool | Why | Install (macOS) | Install (Linux) |
|------|-----|-----------------|-----------------|
| jq | Dependency graph, risk scores, report assembly, schema validation | `brew install jq` | `apt install jq` |

The audit will not proceed without jq. The prerequisite checker detects this
and provides the install command for your OS.

**Optional enhancements:**

Installing optional tools makes the audit faster and more thorough. The
prerequisite checker runs automatically and tells you exactly what to install.

| Tool | What It Improves | Install (macOS) | Install (Linux) |
|------|-----------------|-----------------|-----------------|
| ripgrep | Fast pattern pre-scanning, skeleton extraction | `brew install ripgrep` | `apt install ripgrep` |
| tree | Directory visualization | `brew install tree` | `apt install tree` |
| cloc | Accurate code metrics | `brew install cloc` | `apt install cloc` |

**Language-specific** (only relevant if you use that language):

| Tool | Language | What It Improves | Install |
|------|----------|-----------------|---------|
| pip-audit | Python | Dependency vulnerability scanning | `pip install pip-audit` |
| cargo-audit | Rust | Dependency vulnerability scanning | `cargo install cargo-audit` |
| govulncheck | Go | Dependency vulnerability scanning | `go install golang.org/x/vuln/cmd/govulncheck@latest` |
| bundle-audit | Ruby | Dependency vulnerability scanning | `gem install bundler-audit` |

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

## Architecture

```
Phase 0: Discovery
  Prerequisite check, directory scan, language/framework detection
  Output: sdlc-audit/data/detection.json
       │
Phase 0.5: Pre-Analysis (Deterministic)
  Code metrics, git history, linters, type checkers, dependency audits,
  pattern pre-scans, code skeleton extraction
  Output: sdlc-audit/data/, sdlc-audit/tool-output/, sdlc-audit/prescan/
       │
Phase 1: Deep Analysis (Sub-Agents)
  Parallel sub-agents per module with language-specific guides
  Output: sdlc-audit/modules/*.json
       │
Phase 1.5: Variant Analysis
  Extract recurring patterns, search for sibling instances
  Output: sdlc-audit/data/variant-analysis.json
       │
Phase 2: Cross-Module Analysis
  Stage 1: Dependency graph + risk scoring (bash+jq)
  Stage 2: DRY, inconsistencies, architecture, coverage (parallel LLM agents)
  Output: sdlc-audit/data/dependency-data.json, risk-scores.json, cross-module-*.json
       │
Phase 3: Reports
  Stage 1:  Assembly scripts (bash+jq, parallel) → reports with placeholders
  Stage 1b: Cross-module placeholder fill (bash+jq) → complete reports
  Stage 2:  Patterns + CLAUDE.md (parallel LLM agents)
  Output: sdlc-audit/reports/, sdlc-audit/staged/
       │
Phase 4: Review
  Summary dashboard, user decides what to adopt
```

**Task-based phases**: The orchestrator (`audit.md`) spawns each phase as its
own Task agent with a clean context window, preventing stale instructions from
earlier phases from consuming context space. Each sub-command shares discovery
and pre-analysis phases, and merges its findings into the standard module JSON
format so subsequent commands can reuse prior analysis.

## Running Tests

```bash
bash plugins/repo-audit/tests/run-tests.sh
```

Tests cover all bash scripts and the Python AST parser with fixture-based
assertions. Runs in under 30 seconds on macOS and Linux.

## Adding a Language

Create a new `.md` file in the `lang/` directory following the pattern of
existing guides (File-Level Analysis + Framework-Specific + Cross-Module Checks).
Then add the manifest detection and extension mapping to `phases/discovery.md`.

## Plugin Structure

```
repo-audit/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── commands/
│   ├── audit.md                 # Full audit orchestrator (~290 lines)
│   ├── audit-quick.md           # Fast deterministic scan
│   ├── audit-security.md        # Security-focused audit
│   ├── audit-deps.md            # Dependency analysis
│   ├── audit-arch.md            # Architecture review
│   ├── audit-patterns.md        # Convention discovery
│   └── audit-coverage.md        # Test coverage analysis
├── phases/
│   ├── shared-preamble.md       # Shared rules and discovery reuse logic
│   ├── discovery.md             # Phase 0: language/framework detection
│   ├── pre-analysis.md          # Phase 0.5: deterministic tools
│   ├── deep-analysis.md         # Phase 1: sub-agent spawning
│   ├── variant-analysis.md      # Phase 1.5: pattern sibling search
│   ├── cross-module.md          # Phase 2: cross-module agents
│   ├── report-generation.md     # Phase 3: assembly + synthesis
│   └── review-and-apply.md      # Phase 4: user review
├── schemas/
│   └── enums.json               # Canonical enum definitions (severity, confidence, source)
├── scripts/
│   ├── check-prereqs.sh         # Prerequisite checker (jq required)
│   ├── git-analysis.sh          # Git hotspot and bus factor
│   ├── build-dep-graph.sh       # Dependency graph builder (bash+jq)
│   ├── compute-risk-scores.sh   # Confidence-weighted risk scoring (bash+jq)
│   ├── extract-variants.sh      # Variant pattern extractor (bash+jq)
│   ├── extract-skeletons.py     # Python AST skeleton extractor
│   ├── extract-skeletons-ts.sh  # TypeScript/JS skeleton extractor (grep)
│   ├── extract-skeletons-go.sh  # Go skeleton extractor (grep)
│   ├── extract-skeletons-rust.sh # Rust skeleton extractor (grep)
│   ├── extract-skeletons-java.sh # Java skeleton extractor (grep)
│   ├── validate-module-json.sh  # Module JSON schema validator
│   ├── merge-module-findings.sh # Merge sub-command findings into module JSONs
│   ├── fill-cross-module-placeholders.sh # Fill report placeholders with cross-module data
│   ├── write-audit-meta.sh      # Audit metadata writer (version + detection hash)
│   ├── assemble-audit-report.sh # Report assembly: findings by severity
│   ├── assemble-project-map.sh  # Report assembly: project map
│   ├── assemble-tech-debt.sh    # Report assembly: tech debt backlog
│   ├── assemble-test-coverage.sh # Report assembly: test coverage map
│   └── assemble-dep-graph.sh    # Report assembly: dependency graph
├── lang/                        # 15 language-specific audit guides
│   ├── typescript.md
│   ├── python.md
│   ├── go.md
│   └── ...
├── tests/
│   ├── fixtures/                # Test fixtures (module JSONs, findings JSONs)
│   ├── test-*.sh                # Per-script test files (18 suites)
│   ├── test-extract-skeletons.py
│   └── run-tests.sh             # Test runner
├── README.md
└── LICENSE
```

## FAQ

**How long does it take?**
`/audit-quick`: 30-60 seconds. `/audit`: 5-15 minutes. Sub-commands: 1-5 minutes each.

**Which command should I run first?**
Start with `/audit-quick` for instant signal. If you want deeper analysis,
run `/audit` for the full audit or a specific sub-command for targeted analysis.

**Will it modify my code?**
No. It only creates files inside `sdlc-audit/`. Your source code, config,
and existing files are never touched.

**What about CLAUDE.md?**
The audit proposes CLAUDE.md content in `sdlc-audit/staged/CLAUDE.md`. You
review it and copy what you want into your actual CLAUDE.md.

**Can I run sub-commands after a full audit?**
Yes. Sub-commands reuse existing discovery data and module analysis from
previous runs when available.

**Can I run it again?**
Yes. If a previous audit exists, you'll be offered incremental mode.

**How do I undo it?**
`rm -rf sdlc-audit/` — that's it. Nothing else was changed.

**Does it work on monorepos?**
Yes. Each package/service is treated as an independent audit unit, then
cross-analyzed.

**What if a sub-agent fails?**
The audit continues and notes incomplete coverage in the report.

**Do I need to install anything?**
jq is the only required dependency. The prerequisite checker will detect if
it's missing and provide the install command for your OS. Beyond jq, optional
tools (ripgrep, cloc, tree) make the audit faster and more thorough.

**What's the difference between the confidence levels?**
*Definite* = from a tool (linter, type checker, CVE database). Always accurate.
*High* = grep pattern match. Usually accurate but context may vary.
*Medium* = LLM found it with evidence. Requires human judgment.
*Low* = architectural opinion. Worth considering.

## License

MIT

# repo-audit — Claude Code Plugin

A comprehensive, language-aware codebase audit plugin for Claude Code.
Auto-detects your languages and frameworks, runs your existing tools,
spawns per-module sub-agents and specialist agents, and generates actionable
reports plus a machine-readable TASKS.json — all without touching a single
line of your code.

## Install

```
/plugin install repo-audit
```

After installing, build the MCP server:

```bash
cd "$(claude plugin path repo-audit)/server" && npm install && npm run build
```

**Requires:** Node.js >= 18 (for the MCP server)

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

Runs the complete analysis with module sub-agents, 6 specialist agents,
cross-module analysis, and generates reports + TASKS.json.
Takes 5-15 minutes depending on repo size.

Or with the plugin namespace (if you have a naming conflict):

```
/repo-audit:audit
```

## Commands

| Command | What It Does | Time | Output |
|---------|-------------|------|--------|
| `/audit` | Full audit — module analysis, specialists, cross-module synthesis, TASKS.json | 5-15 min | Reports + TASKS.json |
| `/audit-quick` | Fast deterministic-only scan — linters, type checkers, dependency audits | 30-60 sec | QUICK_SCAN.md |
| `/audit-security` | Security-focused — secrets, CVEs, injection patterns, auth, OWASP Top 10 | 2-3 min | SECURITY_REPORT.md |
| `/audit-deps` | Dependency analysis — module graph, circular deps, hub/orphan modules | 1-2 min | DEPENDENCY_GRAPH.md |
| `/audit-arch` | Architecture review — god modules, layering violations, coupling, risk scores | 3-5 min | ARCHITECTURE_REVIEW.md |
| `/audit-patterns` | Convention discovery — naming, error handling, testing patterns, CLAUDE.md | 2-3 min | PATTERNS.md + CLAUDE.md |
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

1. **Confirmation** — Explains what the audit will do, estimates scope, asks you
   to confirm. If a previous audit exists, offers incremental mode.
2. **Discovery** (~30s) — MCP tool scans directory structure, detects languages,
   frameworks, and tooling. Checks prerequisites.
3. **Pre-analysis** (~1-2min) — MCP tool runs linters, type checkers, dependency
   audits, pattern pre-scans, and code skeleton extraction in parallel.
4. **Plan** — MCP tool reads detection data, applies batching rules, and creates
   module assignments.
5. **Deep analysis** (~3-10min) — Spawns parallel sub-agents per module, each with
   language-specific guides, skeleton data, and pre-analysis results.
6. **Validation** — MCP tool validates module JSONs. Failed modules get one retry.
7. **Specialists** (~1-3min) — MCP tool triages specialist domains. Spawns
   specialist agents (error handling, security, type design, test quality,
   performance, complexity) for domains that meet thresholds.
8. **Cross-module** (~1-2min) — MCP tool builds dependency graph and risk scores.
   Spawns cross-module agents for DRY violations, inconsistencies, architecture,
   and coverage.
9. **Reports** (~30s) — MCP tool runs assembly scripts in parallel, generates
   TASKS.json, returns synthesis prompts for PATTERNS.md and CLAUDE.md.
10. **Summary** — Presents dashboard with all findings.

**Progress reporting**: Every step reports status as it completes.

## Specialist Agents

The full audit includes 6 specialist agents that perform deep-dive analysis
when module-level triage flags enough concerns:

| Specialist | Triggers When | Focus |
|-----------|--------------|-------|
| Error Handling | 1+ files flagged | Silent failures, broad catches, fallback masking |
| Security | 1+ files flagged | Auth flows, injection, OWASP Top 10, secrets |
| Type Design | 3+ files flagged | Invariant strength, anemic models, illegal states |
| Test Quality | 1+ files flagged | Coverage gaps, happy-path-only, over-mocking |
| Performance | 3+ files flagged | N+1 queries, memory leaks, unbounded fetching |
| Complexity | 5+ files flagged | God objects, unnecessary abstraction, readability |

Each specialist writes structured findings to `sdlc-audit/specialists/`.
Sub-commands can also invoke specialists directly (e.g., `/audit-security`
runs the security specialist).

## Confidence Scoring

Every finding includes a confidence level so you can focus on what matters:

| Confidence | Source | What It Means |
|-----------|--------|--------------|
| **Definite** | Linters, type checkers, CVE databases | Facts from deterministic tools. Always accurate. |
| **High** | Pattern pre-scan (grep-based detection) | Pattern matched. Context might make it valid, but usually a real issue. |
| **Medium** | LLM sub-agent analysis | Code was read and analyzed with clear evidence cited. Requires judgment. |
| **Low** | Cross-module / architectural opinions | Subjective assessment. Worth considering but may not apply. |

Reports show a "high-confidence findings" summary at the top for quick triage.
All enum values are defined in `schemas/enums.json`.

## Output

All output is contained in a single directory at your project root:

```
sdlc-audit/
├── AUDIT_REPORT.md                 # All findings by severity — start here
├── TASKS.json                      # Machine-readable task list (NEW in v3)
├── reports/                        # Human-readable reports
│   ├── QUICK_SCAN.md
│   ├── SECURITY_REPORT.md
│   ├── ARCHITECTURE_REVIEW.md
│   ├── PROJECT_MAP.md
│   ├── PATTERNS.md
│   ├── TECH_DEBT.md
│   ├── DEPENDENCY_GRAPH.md
│   └── TEST_COVERAGE_MAP.md
│
├── staged/                         # Proposed changes — your choice to apply
│   └── CLAUDE.md
│
├── data/                           # Machine-readable analysis data
│   ├── detection.json
│   ├── tool-availability.json
│   ├── metrics.json
│   ├── git-hotspots.txt
│   ├── git-busfactor.txt
│   ├── dependency-data.json
│   ├── risk-scores.json
│   ├── variant-analysis.json
│   ├── validation-results.json
│   ├── assignment-plan.json
│   ├── specialist-plan.json
│   ├── .audit-meta.json
│   ├── .audit-state.json
│   ├── cross-module-*.json
│   └── skeletons/
│
├── specialists/                    # Specialist agent findings (NEW in v3)
│   ├── error-handling-findings.json
│   ├── security-findings.json
│   ├── type-design-findings.json
│   ├── test-quality-findings.json
│   ├── performance-findings.json
│   └── complexity-findings.json
│
├── tool-output/                    # Raw output from your repo's tools
│   ├── linter-results/
│   ├── typecheck/
│   └── deps/
│
├── prescan/                        # Pattern pre-scan results
│   └── prescan-summary.txt
│
└── modules/                        # Detailed per-module analysis JSON
    ├── src_auth.json
    └── ...
```

### TASKS.json

New in v3 — a machine-readable task list generated from all audit findings:

```json
{
  "version": "1.0",
  "generated": "2026-02-24T...",
  "tasks": [
    {
      "id": "SEC-001",
      "title": "Fix SQL injection in query builder",
      "severity": "critical",
      "confidence": "high",
      "category": "security",
      "files": ["src/db/queries.ts:23", "src/db/queries.ts:45"],
      "description": "...",
      "suggestion": "Use parameterized queries...",
      "acceptance_criteria": "All database queries use parameterized inputs",
      "estimated_effort": "small",
      "systemic": false
    }
  ]
}
```

Tasks are grouped (5 instances of the same issue become 1 task), prioritized by
severity and confidence, and include effort estimates.

**Where to start:** `sdlc-audit/AUDIT_REPORT.md` (full audit) or
`sdlc-audit/reports/QUICK_SCAN.md` (quick scan)

**Who should read what:**

| Report | Best for |
|--------|----------|
| AUDIT_REPORT.md | Everyone — all findings by severity with confidence |
| TASKS.json | Automation — machine-readable task list for issue trackers |
| QUICK_SCAN.md | Quick check — linter/type/CVE results in 60 seconds |
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
`.audit-meta.json`. If either changes between runs, incremental mode will
warn you that a full audit is recommended.

## Prerequisites

**Required:**

| Tool | Why | Install (macOS) | Install (Linux) |
|------|-----|-----------------|-----------------|
| Node.js >= 18 | MCP server runtime | `brew install node` | `apt install nodejs` |
| jq | Dependency graph, risk scores, report assembly, schema validation | `brew install jq` | `apt install jq` |

The audit will not proceed without jq. The MCP server requires Node.js.
The prerequisite checker detects missing tools and provides install commands.

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

v3 uses a hybrid architecture: a TypeScript MCP server handles all deterministic
work (file I/O, JSON parsing, subprocess orchestration, context assembly, token
budgeting), while LLM judgment work is done by Task agents with assembled prompts.

```
┌─────────────────────────────────────────────────┐
│  Commands (audit.md, audit-*.md)                │
│  Slim orchestrators: ~70-140 lines each         │
│  Call MCP tools + spawn Task agents             │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  MCP Server (server/src/)                       │
│  10 tools: discover, run_tools, plan_analysis,  │
│  get_module_context, validate_modules,          │
│  build_graphs, plan_specialists,                │
│  get_specialist_context, assemble_outputs,      │
│  get_status                                     │
└────────────────────┬────────────────────────────┘
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
┌─────────┐  ┌──────────────┐  ┌──────────────┐
│ Scripts  │  │ Module Agents │  │ Specialist   │
│ (bash)   │  │ (per-module   │  │ Agents (6)   │
│ 18 tools │  │  sub-agents)  │  │ + cross-mod  │
└─────────┘  └──────────────┘  └──────────────┘
```

**MCP tools handle:**
- Directory scanning and language detection
- Running linters, type checkers, dependency audits in parallel
- Planning module assignments with batching rules
- Assembling per-agent context with token budgeting
- Validating module JSON output
- Building dependency graphs and risk scores
- Planning specialist agent assignments
- Assembling specialist context with guide section filtering
- Running report assembly scripts and generating TASKS.json

**LLM agents handle:**
- Deep code analysis requiring judgment
- Cross-module pattern recognition
- Specialist domain analysis
- Report synthesis (PATTERNS.md, CLAUDE.md)

## Running Tests

```bash
# Bash script tests (18 suites)
bash plugins/repo-audit/tests/run-tests.sh

# MCP server build
cd plugins/repo-audit/server && npm run build
```

Tests cover all bash scripts and the Python AST parser with fixture-based
assertions. Runs in under 30 seconds on macOS and Linux.

## Adding a Language

Create a new `.md` file in the `lang/` directory following the pattern of
existing guides (File-Level Analysis + Framework-Specific + Cross-Module Checks).
Then add the manifest detection and extension mapping to `phases/discovery.md`
and `server/src/tools/discover.ts`.

## Plugin Structure

```
repo-audit/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (v3.0.0)
├── .mcp.json                    # MCP server configuration
├── server/                      # TypeScript MCP server (NEW in v3)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts             # Server entry point, 10 tool registrations
│       ├── tools/               # Tool implementations
│       │   ├── get-status.ts
│       │   ├── discover.ts
│       │   ├── run-tools.ts
│       │   ├── plan-analysis.ts
│       │   ├── get-module-context.ts
│       │   ├── validate-modules.ts
│       │   ├── build-graphs.ts
│       │   ├── plan-specialists.ts
│       │   ├── get-specialist-context.ts
│       │   └── assemble-outputs.ts
│       └── lib/                 # Shared utilities
│           ├── state.ts         # Audit state management
│           ├── subprocess.ts    # Script execution wrapper
│           ├── tokens.ts        # Token estimation
│           └── detection.ts     # Detection JSON helpers
├── commands/
│   ├── audit.md                 # Full audit orchestrator (~140 lines)
│   ├── audit-quick.md           # Fast deterministic scan
│   ├── audit-security.md        # Security-focused audit
│   ├── audit-deps.md            # Dependency analysis
│   ├── audit-arch.md            # Architecture review
│   ├── audit-patterns.md        # Convention discovery
│   └── audit-coverage.md        # Test coverage analysis
├── agents/                      # Specialist agent definitions (NEW in v3)
│   ├── error-handling-specialist.md
│   ├── security-specialist.md
│   ├── type-design-specialist.md
│   ├── test-quality-specialist.md
│   ├── performance-specialist.md
│   └── complexity-specialist.md
├── phases/
│   ├── shared-preamble.md       # Shared rules and discovery reuse logic
│   ├── discovery.md             # Detection heuristics specification
│   └── cross-module-agents.md   # Cross-module LLM agent prompts
├── schemas/
│   ├── enums.json               # Canonical enum definitions
│   └── tasks.schema.json        # TASKS.json schema (NEW in v3)
├── scripts/                     # Bash scripts (called by MCP server)
│   ├── check-prereqs.sh
│   ├── run-pre-analysis-tools.sh
│   ├── git-analysis.sh
│   ├── build-dep-graph.sh
│   ├── compute-risk-scores.sh
│   ├── extract-variants.sh
│   ├── extract-skeletons.py
│   ├── extract-skeletons-ts.sh
│   ├── extract-skeletons-go.sh
│   ├── extract-skeletons-rust.sh
│   ├── extract-skeletons-java.sh
│   ├── validate-module-json.sh
│   ├── merge-module-findings.sh
│   ├── fill-cross-module-placeholders.sh
│   ├── write-audit-meta.sh
│   ├── assemble-audit-report.sh
│   ├── assemble-project-map.sh
│   ├── assemble-tech-debt.sh
│   ├── assemble-test-coverage.sh
│   └── assemble-dep-graph.sh
├── lang/                        # 15 language-specific audit guides
│   ├── typescript.md
│   ├── python.md
│   ├── go.md
│   └── ...
├── tests/
│   ├── fixtures/                # Test fixtures
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
The audit validates module output and retries failed modules once. If still
failing, it continues and notes incomplete coverage in the report.

**Do I need Node.js?**
Yes, Node.js >= 18 is required for the MCP server. Run
`cd server && npm install && npm run build` after installing the plugin.

**Do I need to install anything else?**
jq is the only other required dependency. Optional tools (ripgrep, cloc, tree)
make the audit faster and more thorough. The prerequisite checker tells you
exactly what to install.

**What are specialist agents?**
Deep-dive analysts that focus on specific domains (security, error handling,
performance, etc.). They're triggered automatically when module analysis flags
enough concerns in their domain.

**What's TASKS.json?**
A machine-readable task list generated from all audit findings. Tasks are
grouped, prioritized, and include effort estimates. Use it to create issues
in your tracker or feed into automation.

**What's the difference between the confidence levels?**
*Definite* = from a tool (linter, type checker, CVE database). Always accurate.
*High* = grep pattern match. Usually accurate but context may vary.
*Medium* = LLM found it with evidence. Requires human judgment.
*Low* = architectural opinion. Worth considering.

## License

MIT

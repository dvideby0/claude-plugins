# Phase 4: Review and Apply

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

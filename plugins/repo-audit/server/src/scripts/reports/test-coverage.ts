/**
 * Test Coverage Map Assembler.
 * Migrated from scripts/assemble-test-coverage.sh (161 LOC).
 *
 * Per-module test coverage assessment with risk-weighted prioritization.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readAllModules } from "../../lib/modules.js";
import { markdownTable, safeReadJson, REPORT_FOOTER } from "./common.js";
import type { RiskScoresOutput, ModuleJson } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coverageOrder(cov: string): number {
  if (cov === "none") return 0;
  if (cov === "partial") return 1;
  if (cov === "full") return 2;
  return 3;
}

function countTestingIssues(mod: ModuleJson): number {
  let count = 0;
  for (const file of mod.files ?? []) {
    for (const issue of file.issues ?? []) {
      if (issue.category === "testing" || issue.category === "test_quality") {
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function assembleTestCoverageReport(projectRoot: string): Promise<void> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const modulesDir = join(auditDir, "modules");
  const dataDir = join(auditDir, "data");
  const reportsDir = join(auditDir, "reports");

  await mkdir(reportsDir, { recursive: true });

  const modules = await readAllModules(modulesDir);
  if (modules.length === 0) {
    await writeFile(
      join(reportsDir, "TEST_COVERAGE_MAP.md"),
      "# Test Coverage Map\n\nNo module data available.\n" + REPORT_FOOTER,
    );
    return;
  }

  // Sort: none first, then partial, then full
  const sorted = [...modules].sort((a, b) => {
    const covDiff = coverageOrder(a.data.test_coverage) - coverageOrder(b.data.test_coverage);
    if (covDiff !== 0) return covDiff;
    return a.data.directory.localeCompare(b.data.directory);
  });

  const riskScores = await safeReadJson<RiskScoresOutput>(readFile, join(dataDir, "risk-scores.json"));
  const riskMap = new Map<string, number>();
  if (riskScores) {
    for (const s of riskScores.scores) {
      riskMap.set(s.module, s.risk_score);
    }
  }

  const lines: string[] = [];

  // Header
  lines.push("# Test Coverage Map\n");

  // Coverage table
  lines.push("## Coverage by Module\n");
  const rows = sorted.map((m) => {
    const issueCount = (m.data.files ?? []).reduce(
      (sum, f) => sum + (f.issues?.length ?? 0),
      0,
    );
    const risk = riskMap.get(m.data.directory);
    return [
      m.data.directory,
      m.data.category ?? "—",
      m.data.test_coverage,
      String(issueCount),
      risk !== undefined ? risk.toFixed(1) : "—",
    ];
  });
  lines.push(markdownTable(
    ["Module", "Category", "Coverage", "Issues", "Risk Score"],
    rows,
  ));
  lines.push("");

  // Untested modules
  const untested = sorted.filter((m) => m.data.test_coverage === "none");
  lines.push("## Untested Modules\n");
  if (untested.length > 0) {
    for (const m of untested) {
      lines.push(`- **${m.data.directory}** (${m.data.total_lines ?? "?"} lines)`);
    }
  } else {
    lines.push("All modules have at least partial test coverage.");
  }
  lines.push("");

  // Critical untested paths
  lines.push("## Critical Untested Paths\n");
  if (untested.length > 0 && riskScores) {
    // Join untested with risk scores, sort by risk descending
    const untestedRisks = untested
      .map((m) => ({
        module: m.data.directory,
        risk: riskMap.get(m.data.directory) ?? 0,
        lines: m.data.total_lines ?? 0,
      }))
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 10);

    for (const item of untestedRisks) {
      lines.push(
        `- **${item.module}**: risk=${item.risk.toFixed(1)}, ${item.lines} lines — highest priority for testing`,
      );
    }
  } else if (untested.length > 0) {
    lines.push(`${untested.length} untested modules found. Run risk scoring for prioritization.`);
  } else {
    lines.push("No untested modules.");
  }
  lines.push("");

  // Partially tested modules
  const partial = sorted.filter((m) => m.data.test_coverage === "partial");
  if (partial.length > 0) {
    lines.push("## Partially Tested Modules\n");
    for (const m of partial) {
      const testIssues = countTestingIssues(m.data);
      const docQuality = m.data.documentation_quality ?? "unknown";
      lines.push(
        `- **${m.data.directory}**: doc_quality=${docQuality}, testing issues=${testIssues}`,
      );
    }
    lines.push("");
  }

  // All testing issues across modules
  const testingIssues: Array<{ module: string; description: string }> = [];
  for (const m of modules) {
    for (const file of m.data.files ?? []) {
      for (const issue of file.issues ?? []) {
        if (issue.category === "testing" || issue.category === "test_quality") {
          testingIssues.push({
            module: m.data.directory,
            description: issue.description,
          });
        }
      }
    }
  }
  if (testingIssues.length > 0) {
    lines.push("## Testing Issues\n");
    for (const issue of testingIssues) {
      lines.push(`- **${issue.module}**: ${issue.description}`);
    }
    lines.push("");
  } else {
    lines.push("## Testing Issues\n");
    lines.push("No testing-specific issues found.\n");
  }

  // Suggested priorities
  lines.push("## Suggested Priorities\n");
  lines.push("1. Add tests for untested modules with highest risk scores");
  lines.push("2. Improve coverage of partially tested critical-path modules");
  lines.push("3. Address testing-specific issues found during audit");
  lines.push("4. Set up CI test coverage reporting to track progress\n");

  // Placeholder for cross-module coverage gaps
  lines.push("<!-- COVERAGE_GAPS_PLACEHOLDER -->");
  lines.push(REPORT_FOOTER);

  await writeFile(join(reportsDir, "TEST_COVERAGE_MAP.md"), lines.join("\n"));
}

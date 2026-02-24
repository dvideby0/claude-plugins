import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assembleTechDebtReport } from "../../../scripts/reports/tech-debt.js";
import {
  createTestProject,
  copyFixture,
  type TestProject,
} from "../../helpers.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

describe("assembleTechDebtReport", () => {
  it("produces a report with header and issue count", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("# Tech Debt Backlog");
    expect(report).toContain("Total issues found:");
  });

  it("handles empty project", async () => {
    project = await createTestProject();

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("# Tech Debt Backlog");
    expect(report).toContain("Total issues found:** 0");
  });

  it("includes Quick Wins section", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("## Quick Wins");
  });

  it("includes Strategic Improvements section", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("## Strategic Improvements");
  });

  it("includes Major Refactors for critical issues", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("## Major Refactors");
    expect(report).toContain("security");
  });

  it("includes DRY and architecture placeholders", async () => {
    project = await createTestProject();

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("<!-- DRY_VIOLATIONS_PLACEHOLDER -->");
    expect(report).toContain("<!-- ARCHITECTURE_ISSUES_PLACEHOLDER -->");
  });

  it("includes linter findings when present", async () => {
    project = await createTestProject();
    const linterDir = join(project.toolOutputDir, "linter-results");
    await mkdir(linterDir, { recursive: true });

    // Write ESLint-format output
    await writeFile(
      join(linterDir, "eslint.json"),
      JSON.stringify([
        { filePath: "a.ts", messages: [{ ruleId: "no-unused-vars", message: "x" }] },
        { filePath: "b.ts", messages: [{ ruleId: "no-any", message: "y" }, { ruleId: "no-any", message: "z" }] },
      ]),
    );

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("eslint");
    expect(report).toContain("3 auto-fixable violations");
    expect(report).toContain("npx eslint . --fix");
  });

  it("includes risk-weighted priorities when risk scores exist", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await writeFile(
      join(project.dataDir, "risk-scores.json"),
      JSON.stringify({
        scores: [
          { module: "src_api", risk_score: 8.5, issue_count: 3, test_coverage: "none", total_lines: 1200, weighted_issue_count: 5, high_complexity: 2, documentation_quality: "missing", fan_in: 0, blast_radius: 10, complexity: 5, safety_net: 0.5 },
        ],
        top_10_highest_risk: ["src_api"],
        risk_distribution: { critical: 1, high: 0, medium: 0, low: 0 },
      }),
    );

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("## Risk-Weighted Priorities");
    expect(report).toContain("8.5");
    expect(report).toContain("src_api");
  });

  it("includes report footer", async () => {
    project = await createTestProject();

    await assembleTechDebtReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).toContain("Generated by repo-audit");
  });
});

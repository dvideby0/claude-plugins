import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assembleTestCoverageReport } from "../../../scripts/reports/test-coverage.js";
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

describe("assembleTestCoverageReport", () => {
  it("handles empty project", async () => {
    project = await createTestProject();

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("# Test Coverage Map");
    expect(report).toContain("No module data available");
  });

  it("produces a coverage table with module data", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);
    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("## Coverage by Module");
    expect(report).toContain("| Module |");
    expect(report).toContain("src_api");
    expect(report).toContain("src_auth");
    expect(report).toContain("src_utils");
  });

  it("sorts modules by coverage level (none first)", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir); // none
    await copyFixture("src_auth.json", project.modulesDir); // partial
    await copyFixture("src_utils.json", project.modulesDir); // full

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    // src_api (none) should appear before src_auth (partial)
    const apiIdx = report.indexOf("src_api");
    const authIdx = report.indexOf("src_auth");
    const utilsIdx = report.indexOf("src_utils");
    expect(apiIdx).toBeLessThan(authIdx);
    expect(authIdx).toBeLessThan(utilsIdx);
  });

  it("lists untested modules", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir); // none

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("## Untested Modules");
    expect(report).toContain("src_api");
  });

  it("shows 'all have coverage' when no untested modules", async () => {
    project = await createTestProject();
    await copyFixture("src_utils.json", project.modulesDir); // full

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("All modules have at least partial test coverage");
  });

  it("includes risk-scored untested paths", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await writeFile(
      join(project.dataDir, "risk-scores.json"),
      JSON.stringify({
        scores: [
          { module: "src_api", risk_score: 9.2, issue_count: 3, test_coverage: "none", total_lines: 1200, weighted_issue_count: 5, high_complexity: 2, documentation_quality: "missing", fan_in: 0, blast_radius: 10, complexity: 5, safety_net: 0.5 },
        ],
        top_10_highest_risk: ["src_api"],
        risk_distribution: { critical: 1, high: 0, medium: 0, low: 0 },
      }),
    );

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("## Critical Untested Paths");
    expect(report).toContain("risk=9.2");
  });

  it("includes suggested priorities section", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("## Suggested Priorities");
  });

  it("includes coverage gaps placeholder", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("<!-- COVERAGE_GAPS_PLACEHOLDER -->");
  });

  it("includes report footer", async () => {
    project = await createTestProject();
    await copyFixture("src_api.json", project.modulesDir);

    await assembleTestCoverageReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).toContain("Generated by repo-audit");
  });
});

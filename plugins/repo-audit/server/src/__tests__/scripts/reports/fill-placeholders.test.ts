import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fillCrossModulePlaceholders } from "../../../scripts/reports/fill-placeholders.js";
import {
  createTestProject,
  type TestProject,
} from "../../helpers.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

async function writeReport(
  reportsDir: string,
  name: string,
  content: string,
): Promise<void> {
  await writeFile(join(reportsDir, name), content);
}

async function writeCrossModuleData(
  dataDir: string,
  name: string,
  data: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(dataDir, name), JSON.stringify(data));
}

describe("fillCrossModulePlaceholders", () => {
  it("does nothing when no reports or cross-module data exist", async () => {
    project = await createTestProject();

    // Should not throw
    await fillCrossModulePlaceholders(project.projectRoot);
  });

  it("replaces CROSS_MODULE_PLACEHOLDER in audit report", async () => {
    project = await createTestProject();

    await writeReport(
      project.reportsDir,
      "AUDIT_REPORT.md",
      "# Report\n\n<!-- CROSS_MODULE_PLACEHOLDER -->\n\nFooter",
    );
    await writeCrossModuleData(project.dataDir, "cross-module-dry.json", {
      duplications: [
        {
          description: "Duplicated validation logic",
          locations: ["src_api", "src_auth"],
          suggestion: "Extract to shared utility",
        },
      ],
    });

    await fillCrossModulePlaceholders(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "AUDIT_REPORT.md"),
      "utf-8",
    );
    expect(report).not.toContain("<!-- CROSS_MODULE_PLACEHOLDER -->");
    expect(report).toContain("Cross-Module Analysis");
    expect(report).toContain("DRY Violations");
    expect(report).toContain("Duplicated validation logic");
    expect(report).toContain("Extract to shared utility");
  });

  it("replaces DRY_VIOLATIONS_PLACEHOLDER in tech debt", async () => {
    project = await createTestProject();

    await writeReport(
      project.reportsDir,
      "TECH_DEBT.md",
      "# Debt\n\n<!-- DRY_VIOLATIONS_PLACEHOLDER -->\n\nEnd",
    );
    await writeCrossModuleData(project.dataDir, "cross-module-dry.json", {
      duplications: [
        {
          description: "Repeated error handling",
          locations: ["a", "b", "c"],
          suggestion: "Use middleware",
        },
      ],
    });

    await fillCrossModulePlaceholders(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).not.toContain("<!-- DRY_VIOLATIONS_PLACEHOLDER -->");
    expect(report).toContain("Repeated error handling");
  });

  it("replaces ARCHITECTURE_ISSUES_PLACEHOLDER in tech debt", async () => {
    project = await createTestProject();

    await writeReport(
      project.reportsDir,
      "TECH_DEBT.md",
      "# Debt\n\n<!-- ARCHITECTURE_ISSUES_PLACEHOLDER -->\n\nEnd",
    );
    await writeCrossModuleData(project.dataDir, "cross-module-architecture.json", {
      architecture_issues: [
        {
          type: "coupling",
          description: "Tight coupling between auth and api",
          affected_modules: ["src_api", "src_auth"],
          suggestion: "Introduce interface layer",
        },
      ],
    });

    await fillCrossModulePlaceholders(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TECH_DEBT.md"),
      "utf-8",
    );
    expect(report).not.toContain("<!-- ARCHITECTURE_ISSUES_PLACEHOLDER -->");
    expect(report).toContain("Tight coupling between auth and api");
  });

  it("replaces DEP_GRAPH_INTERPRETATION_PLACEHOLDER", async () => {
    project = await createTestProject();

    await writeReport(
      project.reportsDir,
      "DEPENDENCY_GRAPH.md",
      "# Deps\n\n<!-- DEP_GRAPH_INTERPRETATION_PLACEHOLDER -->\n\nEnd",
    );
    await writeCrossModuleData(project.dataDir, "cross-module-architecture.json", {
      architecture_issues: [],
      dependency_interpretation: {
        problematic_cycles: [
          { cycle: ["a", "b"], reason: "Creates tight coupling" },
        ],
        hub_assessment: [
          { module: "utils", assessment: "Acceptable shared utility" },
        ],
        decoupling_suggestions: [
          "Extract shared types into a separate module",
        ],
      },
    });

    await fillCrossModulePlaceholders(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).not.toContain("<!-- DEP_GRAPH_INTERPRETATION_PLACEHOLDER -->");
    expect(report).toContain("Problematic Cycles");
    expect(report).toContain("a → b");
    expect(report).toContain("Creates tight coupling");
    expect(report).toContain("Hub Assessment");
    expect(report).toContain("Decoupling Suggestions");
  });

  it("replaces COVERAGE_GAPS_PLACEHOLDER", async () => {
    project = await createTestProject();

    await writeReport(
      project.reportsDir,
      "TEST_COVERAGE_MAP.md",
      "# Coverage\n\n<!-- COVERAGE_GAPS_PLACEHOLDER -->\n\nEnd",
    );
    await writeCrossModuleData(project.dataDir, "cross-module-coverage.json", {
      test_gaps: [
        {
          module: "src_api",
          priority: "critical",
          description: "No tests for API routes",
          risk_note: "Highest risk module",
        },
        {
          module: "src_utils",
          priority: "low",
          description: "Missing edge case tests",
        },
      ],
    });

    await fillCrossModulePlaceholders(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "TEST_COVERAGE_MAP.md"),
      "utf-8",
    );
    expect(report).not.toContain("<!-- COVERAGE_GAPS_PLACEHOLDER -->");
    expect(report).toContain("Coverage Gap Analysis");
    expect(report).toContain("src_api");
    expect(report).toContain("critical");
    expect(report).toContain("Highest risk module");
  });

  it("removes placeholder when cross-module data is empty", async () => {
    project = await createTestProject();

    await writeReport(
      project.reportsDir,
      "AUDIT_REPORT.md",
      "# Report\nBefore\n<!-- CROSS_MODULE_PLACEHOLDER -->\nAfter",
    );
    await writeCrossModuleData(project.dataDir, "cross-module-dry.json", {
      duplications: [],
    });

    await fillCrossModulePlaceholders(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "AUDIT_REPORT.md"),
      "utf-8",
    );
    expect(report).not.toContain("<!-- CROSS_MODULE_PLACEHOLDER -->");
    expect(report).toContain("Before");
    expect(report).toContain("After");
  });

  it("fills inconsistencies in audit report", async () => {
    project = await createTestProject();

    await writeReport(
      project.reportsDir,
      "AUDIT_REPORT.md",
      "# Report\n<!-- CROSS_MODULE_PLACEHOLDER -->\n",
    );
    await writeCrossModuleData(project.dataDir, "cross-module-inconsistencies.json", {
      inconsistencies: [
        {
          pattern_type: "naming",
          description: "Inconsistent function naming",
          examples: [{ module: "src_api" }, { module: "src_auth" }],
          recommendation: "Adopt camelCase",
        },
      ],
    });

    await fillCrossModulePlaceholders(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "AUDIT_REPORT.md"),
      "utf-8",
    );
    expect(report).toContain("Inconsistencies");
    expect(report).toContain("naming");
    expect(report).toContain("Inconsistent function naming");
    expect(report).toContain("Adopt camelCase");
  });
});

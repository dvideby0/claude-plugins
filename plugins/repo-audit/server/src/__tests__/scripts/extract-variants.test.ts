import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractVariants } from "../../scripts/extract-variants.js";
import {
  createTestProject,
  copyFixture,
  type TestProject,
} from "../helpers.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

describe("extractVariants", () => {
  it("detects systemic patterns (same rule in 3+ directories)", async () => {
    project = await createTestProject();

    // DRY-001-no-duplicate-logic appears in src/auth, src/utils, src/api = 3 dirs
    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const result = await extractVariants(project.projectRoot);

    expect(result.systemic_patterns).toHaveProperty("DRY-001-no-duplicate-logic");
    expect(result.systemic_patterns["DRY-001-no-duplicate-logic"].count).toBe(3);
    expect(result.systemic_patterns["DRY-001-no-duplicate-logic"].directories.length).toBe(3);
  });

  it("extracts single-critical issues", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const result = await extractVariants(project.projectRoot);

    // SEC-001 (hardcoded secrets) appears once as critical
    expect(result.single_critical).toHaveProperty("SEC-001-no-hardcoded-secrets");
    expect(result.single_critical["SEC-001-no-hardcoded-secrets"].severity).toBe("critical");

    // SEC-002 (input validation) appears once as critical
    expect(result.single_critical).toHaveProperty("SEC-002-input-validation");
  });

  it("computes correct total_high_severity count", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const result = await extractVariants(project.projectRoot);

    // auth: 4 issues (1 crit, 3 warn), utils: 1 warn, api: 3 (1 crit, 2 warn)
    // Total = 8
    expect(result.total_high_severity).toBe(8);
  });

  it("computes category distribution", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const result = await extractVariants(project.projectRoot);

    expect(result.category_distribution).toHaveProperty("security");
    expect(result.category_distribution).toHaveProperty("maintainability");
    expect(result.category_distribution.security).toBe(5);
    expect(result.category_distribution.maintainability).toBe(3);
  });

  it("handles modules with no issues", async () => {
    project = await createTestProject();

    await writeFile(
      join(project.modulesDir, "src_clean.json"),
      JSON.stringify({
        directory: "src_clean",
        total_lines: 100,
        test_coverage: "full",
        documentation_quality: "comprehensive",
        internal_dependencies: [],
        external_dependencies: [],
        files: [
          { path: "src/clean/main.py", issues: [] },
        ],
      }),
    );

    const result = await extractVariants(project.projectRoot);

    expect(result.total_high_severity).toBe(0);
    expect(Object.keys(result.systemic_patterns)).toHaveLength(0);
    expect(Object.keys(result.single_critical)).toHaveLength(0);
  });

  it("handles empty modules directory", async () => {
    project = await createTestProject();

    const result = await extractVariants(project.projectRoot);

    expect(result.total_high_severity).toBe(0);
    expect(Object.keys(result.systemic_patterns)).toHaveLength(0);
    expect(Object.keys(result.single_critical)).toHaveLength(0);
  });

  it("excludes issues without guide_rule from pattern grouping", async () => {
    project = await createTestProject();

    await writeFile(
      join(project.modulesDir, "no_rules.json"),
      JSON.stringify({
        directory: "no_rules",
        total_lines: 50,
        test_coverage: "none",
        documentation_quality: "missing",
        internal_dependencies: [],
        external_dependencies: [],
        files: [
          {
            path: "src/no_rules/file.py",
            issues: [
              {
                severity: "critical",
                category: "security",
                description: "Some critical issue without guide_rule",
              },
            ],
          },
        ],
      }),
    );

    const result = await extractVariants(project.projectRoot);

    // Issue is counted in total but not in systemic/single (no guide_rule)
    expect(result.total_high_severity).toBe(1);
    expect(Object.keys(result.systemic_patterns)).toHaveLength(0);
    expect(Object.keys(result.single_critical)).toHaveLength(0);
  });

  it("includes warning-level issues", async () => {
    project = await createTestProject();

    await writeFile(
      join(project.modulesDir, "warnings.json"),
      JSON.stringify({
        directory: "warnings",
        total_lines: 50,
        test_coverage: "none",
        documentation_quality: "missing",
        internal_dependencies: [],
        external_dependencies: [],
        files: [
          {
            path: "src/warnings/file.py",
            issues: [
              {
                severity: "warning",
                category: "performance",
                description: "Slow query",
                guide_rule: "PERF-001",
              },
              {
                severity: "info",
                category: "documentation",
                description: "Missing docstring",
                guide_rule: "DOC-001",
              },
            ],
          },
        ],
      }),
    );

    const result = await extractVariants(project.projectRoot);

    // Only the warning should be counted, not info
    expect(result.total_high_severity).toBe(1);
    expect(result.category_distribution.performance).toBe(1);
    expect(result.category_distribution).not.toHaveProperty("documentation");
  });
});

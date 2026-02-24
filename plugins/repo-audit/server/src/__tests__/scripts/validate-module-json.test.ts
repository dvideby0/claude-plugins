import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateModuleJson } from "../../scripts/validate-module-json.js";
import {
  createTestProject,
  copyFixture,
  type TestProject,
} from "../helpers.js";
import type { ValidationResults } from "../../lib/types.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

describe("validateModuleJson", () => {
  it("passes a fully valid module", async () => {
    project = await createTestProject();
    await copyFixture("src_valid_full.json", project.modulesDir);

    const result = await validateModuleJson(project.projectRoot);

    expect(result.validated).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("detects missing directory field", async () => {
    project = await createTestProject();
    await copyFixture("src_no_dir.json", project.modulesDir);

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    const errors = result.errors[0].errors;
    expect(errors).toContainEqual(
      expect.stringContaining("Missing required field: directory"),
    );
  });

  it("detects invalid severity value", async () => {
    project = await createTestProject();
    await copyFixture("src_bad_severity.json", project.modulesDir);

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    const errors = result.errors[0].errors;
    expect(errors).toContainEqual(
      expect.stringContaining("Invalid severity"),
    );
  });

  it("detects null files field", async () => {
    project = await createTestProject();
    await copyFixture("src_null_files.json", project.modulesDir);

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    const errors = result.errors[0].errors;
    expect(errors).toContainEqual(
      expect.stringContaining("must be an array"),
    );
  });

  it("detects missing issues in file entry", async () => {
    project = await createTestProject();
    await copyFixture("src_missing_issues.json", project.modulesDir);

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    const errors = result.errors[0].errors;
    expect(errors).toContainEqual(
      expect.stringContaining("missing required field: issues"),
    );
  });

  it("returns empty results for empty modules directory", async () => {
    project = await createTestProject();

    const result = await validateModuleJson(project.projectRoot);

    expect(result.validated).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles mix of valid and invalid modules", async () => {
    project = await createTestProject();
    await copyFixture("src_valid_full.json", project.modulesDir);
    await copyFixture("src_bad_severity.json", project.modulesDir);

    const result = await validateModuleJson(project.projectRoot);

    expect(result.validated).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe("src_bad_severity.json");
  });

  it("detects invalid JSON files", async () => {
    project = await createTestProject();
    await writeFile(
      join(project.modulesDir, "broken.json"),
      "{ this is not valid json",
    );

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("Invalid JSON"),
    );
  });

  it("detects invalid confidence value", async () => {
    project = await createTestProject();
    await writeFile(
      join(project.modulesDir, "bad_conf.json"),
      JSON.stringify({
        directory: "bad_conf",
        files: [
          {
            path: "bad_conf/file.ts",
            issues: [
              {
                severity: "warning",
                confidence: "very-high",
                description: "bad confidence",
              },
            ],
          },
        ],
        test_coverage: "none",
        documentation_quality: "missing",
      }),
    );

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("Invalid confidence"),
    );
  });

  it("detects invalid source value", async () => {
    project = await createTestProject();
    await writeFile(
      join(project.modulesDir, "bad_source.json"),
      JSON.stringify({
        directory: "bad_source",
        files: [
          {
            path: "bad_source/file.ts",
            issues: [
              {
                severity: "warning",
                source: "manual-review",
                description: "bad source",
              },
            ],
          },
        ],
        test_coverage: "none",
        documentation_quality: "missing",
      }),
    );

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("Invalid source"),
    );
  });

  it("detects invalid test_coverage enum", async () => {
    project = await createTestProject();
    await writeFile(
      join(project.modulesDir, "bad_tc.json"),
      JSON.stringify({
        directory: "bad_tc",
        files: [],
        test_coverage: "mostly",
        documentation_quality: "missing",
      }),
    );

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("Invalid test_coverage"),
    );
  });

  it("detects invalid documentation_quality enum", async () => {
    project = await createTestProject();
    await writeFile(
      join(project.modulesDir, "bad_dq.json"),
      JSON.stringify({
        directory: "bad_dq",
        files: [],
        test_coverage: "none",
        documentation_quality: "excellent",
      }),
    );

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("Invalid documentation_quality"),
    );
  });

  it("validates module_level_issues severity enum", async () => {
    project = await createTestProject();
    await writeFile(
      join(project.modulesDir, "bad_mli.json"),
      JSON.stringify({
        directory: "bad_mli",
        files: [],
        test_coverage: "none",
        documentation_quality: "missing",
        module_level_issues: [
          {
            severity: "urgent",
            description: "bad severity in module-level",
          },
        ],
      }),
    );

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("Invalid severity"),
    );
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("module_level_issues"),
    );
  });

  it("detects file entry missing path", async () => {
    project = await createTestProject();
    await writeFile(
      join(project.modulesDir, "no_path.json"),
      JSON.stringify({
        directory: "no_path",
        files: [{ issues: [] }],
        test_coverage: "none",
        documentation_quality: "missing",
      }),
    );

    const result = await validateModuleJson(project.projectRoot);

    expect(result.failed).toBe(1);
    expect(result.errors[0].errors).toContainEqual(
      expect.stringContaining("missing required field: path"),
    );
  });

  it("writes output file to correct location", async () => {
    project = await createTestProject();
    await copyFixture("src_valid_full.json", project.modulesDir);

    await validateModuleJson(project.projectRoot);

    const outputPath = join(project.dataDir, "validation-results.json");
    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as ValidationResults;

    expect(parsed.validated).toBe(1);
    expect(parsed.passed).toBe(1);
  });
});

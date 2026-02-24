import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeModuleFindings } from "../../scripts/merge-module-findings.js";
import {
  createTestProject,
  readJsonOutput,
  FIXTURES_DIR,
  type TestProject,
} from "../helpers.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

const SECURITY_FINDINGS = join(FIXTURES_DIR, "findings_security.json");
const ARCH_FINDINGS = join(FIXTURES_DIR, "findings_arch.json");

async function writeDetection(
  dataDir: string,
  dirs: Record<string, { category: string; languages: string[] }>,
) {
  await writeFile(
    join(dataDir, "detection.json"),
    JSON.stringify({ all_directories: dirs }),
  );
}

describe("mergeModuleFindings", () => {
  it("creates new modules from findings", async () => {
    project = await createTestProject();

    await writeDetection(project.dataDir, {
      "src/auth": { category: "source", languages: ["python"] },
      "src/utils": { category: "source", languages: ["python"] },
      "src/api": { category: "source", languages: ["python"] },
    });

    const result = await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);

    // Check src_auth module was created correctly
    const auth = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    expect(auth.directory).toBe("src/auth");
    expect(auth.sources).toEqual(["audit-security"]);
    expect(auth.test_coverage).toBe("unknown");
    expect(auth.category).toBe("source");

    // Two files: config.py and login.py
    const files = auth.files as Array<{ path: string; issues: unknown[] }>;
    expect(files).toHaveLength(2);

    const configFile = files.find((f) => f.path === "src/auth/config.py");
    expect(configFile).toBeDefined();
    expect(configFile!.issues).toHaveLength(1);

    const loginFile = files.find((f) => f.path === "src/auth/login.py");
    expect(loginFile).toBeDefined();
    expect(loginFile!.issues).toHaveLength(1);
  });

  it("merges into existing module, preserving data", async () => {
    project = await createTestProject();

    await writeDetection(project.dataDir, {
      "src/auth": { category: "source", languages: ["python"] },
      "src/utils": { category: "source", languages: ["python"] },
      "src/api": { category: "source", languages: ["python"] },
    });

    // Create existing module with some issues
    const existingModule = {
      directory: "src/auth",
      directories_analyzed: ["src/auth"],
      category: "source",
      languages_found: ["python"],
      purpose: "Authentication and authorization module",
      file_count: 3,
      total_lines: 500,
      files: [
        {
          path: "src/auth/login.py",
          language: "python",
          lines: 200,
          issues: [
            {
              severity: "warning",
              confidence: "high",
              category: "maintainability",
              source: "llm-analysis",
              description: "Function too complex — consider refactoring",
              line_range: [10, 80],
            },
          ],
        },
        {
          path: "src/auth/session.py",
          language: "python",
          lines: 150,
          issues: [],
        },
      ],
      internal_dependencies: ["src/utils"],
      external_dependencies: ["bcrypt"],
      test_coverage: "partial",
      documentation_quality: "sparse",
    };

    await writeFile(
      join(project.modulesDir, "src_auth.json"),
      JSON.stringify(existingModule),
    );

    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    const merged = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );

    // Existing fields preserved
    expect(merged.purpose).toBe("Authentication and authorization module");
    expect(merged.test_coverage).toBe("partial");
    expect(merged.internal_dependencies).toEqual(["src/utils"]);

    // Existing issue preserved
    const files = merged.files as Array<{ path: string; issues: Array<{ description: string }> }>;
    const loginFile = files.find((f) => f.path === "src/auth/login.py")!;
    const existingIssue = loginFile.issues.find(
      (i) => i.description === "Function too complex — consider refactoring",
    );
    expect(existingIssue).toBeDefined();

    // New issue added
    const newIssue = loginFile.issues.find((i) =>
      i.description.includes("SQL injection"),
    );
    expect(newIssue).toBeDefined();

    // New file entry created for config.py
    const configFile = files.find((f) => f.path === "src/auth/config.py");
    expect(configFile).toBeDefined();

    // Sources added
    expect(merged.sources).toEqual(["audit-security"]);
  });

  it("deduplicates issues on re-merge", async () => {
    project = await createTestProject();

    await writeDetection(project.dataDir, {
      "src/auth": { category: "source", languages: ["python"] },
      "src/utils": { category: "source", languages: ["python"] },
      "src/api": { category: "source", languages: ["python"] },
    });

    // First merge
    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    const auth1 = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    const files1 = auth1.files as Array<{ issues: unknown[] }>;
    const count1 = files1.reduce((sum, f) => sum + f.issues.length, 0);

    // Second merge with same findings
    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    const auth2 = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    const files2 = auth2.files as Array<{ issues: unknown[] }>;
    const count2 = files2.reduce((sum, f) => sum + f.issues.length, 0);

    expect(count2).toBe(count1);
  });

  it("deduplicates sources on re-merge", async () => {
    project = await createTestProject();

    await writeDetection(project.dataDir, {
      "src/auth": { category: "source", languages: ["python"] },
      "src/utils": { category: "source", languages: ["python"] },
      "src/api": { category: "source", languages: ["python"] },
    });

    // First merge
    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    // Second merge with same source
    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    const auth = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    expect((auth.sources as string[]).length).toBe(1);

    // Third merge with different source
    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: ARCH_FINDINGS,
      sourceCommand: "audit-arch",
    });

    const auth2 = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    const sources = (auth2.sources as string[]).sort();
    expect(sources).toEqual(["audit-arch", "audit-security"]);
  });

  it("distributes findings across multiple modules", async () => {
    project = await createTestProject();

    await writeDetection(project.dataDir, {
      "src/auth": { category: "source", languages: ["python"] },
      "src/utils": { category: "source", languages: ["python"] },
      "src/api": { category: "source", languages: ["python"] },
    });

    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    // src/auth has 2 findings (config.py + login.py)
    const auth = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    const authIssues = (auth.files as Array<{ issues: unknown[] }>).reduce(
      (sum, f) => sum + f.issues.length,
      0,
    );
    expect(authIssues).toBe(2);

    // src/utils has 1 finding
    const utils = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_utils.json"),
    );
    const utilsIssues = (utils.files as Array<{ issues: unknown[] }>).reduce(
      (sum, f) => sum + f.issues.length,
      0,
    );
    expect(utilsIssues).toBe(1);

    // src/api has 1 finding
    const api = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_api.json"),
    );
    const apiIssues = (api.files as Array<{ issues: unknown[] }>).reduce(
      (sum, f) => sum + f.issues.length,
      0,
    );
    expect(apiIssues).toBe(1);
  });

  it("returns zero counts for empty findings", async () => {
    project = await createTestProject();

    const emptyFile = join(project.projectRoot, "empty.json");
    await writeFile(emptyFile, JSON.stringify({ findings: [] }));

    const result = await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: emptyFile,
      sourceCommand: "audit-security",
    });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.total).toBe(0);
  });

  it("derives module from path when no detection.json", async () => {
    project = await createTestProject();
    // No detection.json created

    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    // src/auth/config.py → "src/auth" → src_auth.json
    const authRaw = await readFile(
      join(project.modulesDir, "src_auth.json"),
      "utf-8",
    );
    expect(authRaw).toBeTruthy();

    const auth = JSON.parse(authRaw);
    expect(auth.directory).toBe("src/auth");
  });

  it("handles dedup with null line_range", async () => {
    project = await createTestProject();

    await writeDetection(project.dataDir, {
      "src/api": { category: "source", languages: ["python"] },
    });

    // findings_security.json has a finding for src/api/routes.py with null line_range
    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    const api1 = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_api.json"),
    );
    const count1 = (
      api1.files as Array<{ path: string; issues: unknown[] }>
    ).find((f) => f.path === "src/api/routes.py")!.issues.length;

    // Re-merge — null line_range findings should be deduped
    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    const api2 = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_api.json"),
    );
    const count2 = (
      api2.files as Array<{ path: string; issues: unknown[] }>
    ).find((f) => f.path === "src/api/routes.py")!.issues.length;

    expect(count2).toBe(count1);
  });

  it("preserves severity from findings", async () => {
    project = await createTestProject();

    await writeDetection(project.dataDir, {
      "src/auth": { category: "source", languages: ["python"] },
    });

    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    const auth = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    const files = auth.files as Array<{
      path: string;
      issues: Array<{ severity: string }>;
    }>;
    const configFile = files.find((f) => f.path === "src/auth/config.py")!;
    expect(configFile.issues[0].severity).toBe("critical");
  });

  it("uses longest prefix match for directory mapping", async () => {
    project = await createTestProject();

    // Create overlapping directories
    await writeDetection(project.dataDir, {
      src: { category: "source", languages: ["python"] },
      "src/auth": { category: "source", languages: ["python"] },
    });

    await mergeModuleFindings({
      projectRoot: project.projectRoot,
      findingsFile: SECURITY_FINDINGS,
      sourceCommand: "audit-security",
    });

    // src/auth/config.py should match "src/auth" (longer), not "src"
    const authExists = await readFile(
      join(project.modulesDir, "src_auth.json"),
      "utf-8",
    ).then(() => true).catch(() => false);
    expect(authExists).toBe(true);

    const auth = await readJsonOutput<Record<string, unknown>>(
      join(project.modulesDir, "src_auth.json"),
    );
    expect(auth.directory).toBe("src/auth");
  });
});

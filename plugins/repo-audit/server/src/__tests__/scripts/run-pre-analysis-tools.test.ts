import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runPreAnalysisTools } from "../../scripts/run-pre-analysis-tools.js";
import {
  createTestProject,
  type TestProject,
} from "../helpers.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a minimal tool-availability.json with all tools unavailable.
 */
async function writeToolAvailability(
  dataDir: string,
  overrides: Record<string, { available: boolean }> = {},
): Promise<void> {
  const tools: Record<string, { available: boolean }> = {
    cloc: { available: false },
    tokei: { available: false },
    rg: { available: false },
    tree: { available: false },
    ...overrides,
  };
  await writeFile(
    join(dataDir, "tool-availability.json"),
    JSON.stringify({ os: "macos", package_manager: "brew", timestamp: "2024-01-01T00:00:00Z", tools, project_tools: {}, detected_languages: {}, install_commands: { all_missing: null, per_tool: {} } }),
  );
}

describe("runPreAnalysisTools", () => {
  it("always succeeds (never throws)", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    // Should not throw even with no tools
    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    expect(result).toHaveProperty("successCount");
    expect(result).toHaveProperty("failureCount");
    expect(typeof result.successCount).toBe("number");
    expect(typeof result.failureCount).toBe("number");
  });

  it("creates required output directories", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    await runPreAnalysisTools({ projectRoot: project.projectRoot });

    const toolOutput = join(project.projectRoot, "sdlc-audit", "tool-output");
    expect(await fileExists(join(toolOutput, "linter-results"))).toBe(true);
    expect(await fileExists(join(toolOutput, "typecheck"))).toBe(true);
    expect(await fileExists(join(toolOutput, "deps"))).toBe(true);
    expect(await fileExists(join(project.dataDir, "skeletons"))).toBe(true);
  });

  it("writes failure log", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    await runPreAnalysisTools({ projectRoot: project.projectRoot });

    const logPath = join(project.dataDir, "pre-analysis-failures.log");
    expect(await fileExists(logPath)).toBe(true);

    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("Pre-Analysis Failure Log");
    expect(logContent).toContain("Generated:");
  });

  it("reports zero failures when no tools configured", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    // With no tools available and no project files, nothing should run
    expect(result.failureCount).toBe(0);
  });

  it("writes 'No failures recorded' when all succeeds", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    await runPreAnalysisTools({ projectRoot: project.projectRoot });

    const logContent = await readFile(
      join(project.dataDir, "pre-analysis-failures.log"),
      "utf-8",
    );
    expect(logContent).toContain("No failures recorded");
  });

  it("skips linters when no config files present", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    // No package.json, pyproject.toml, biome.json, .golangci.yml, .rubocop.yml
    // so no linters should run (successCount should not include any linters)
    const linterDir = join(project.projectRoot, "sdlc-audit", "tool-output", "linter-results");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(linterDir);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("skips dep audits when no lock files present", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    const depsDir = join(project.projectRoot, "sdlc-audit", "tool-output", "deps");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(depsDir);
    expect(files).toHaveLength(0);
  });

  it("skips type checkers when no config files present", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    const typecheckDir = join(project.projectRoot, "sdlc-audit", "tool-output", "typecheck");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(typecheckDir);
    expect(files).toHaveLength(0);
  });

  it("runs git analysis when .git directory exists", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    // Create a real git repo
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: project.projectRoot });
    execSync('git config user.email "test@test.com"', { cwd: project.projectRoot });
    execSync('git config user.name "Test"', { cwd: project.projectRoot });
    await writeFile(join(project.projectRoot, "file.txt"), "test content\n");
    execSync("git add file.txt", { cwd: project.projectRoot });
    execSync('git commit -m "init" -q', { cwd: project.projectRoot });

    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    // Git analysis should have run successfully
    expect(result.successCount).toBeGreaterThanOrEqual(1);

    // Should have written git output files
    const hotspotsExist = await fileExists(join(project.dataDir, "git-hotspots.txt"));
    expect(hotspotsExist).toBe(true);
  });

  it("runs skeleton extractors when language detected", async () => {
    project = await createTestProject();
    await writeToolAvailability(project.dataDir);

    // Write detection.json with TypeScript detected
    await writeFile(
      join(project.dataDir, "detection.json"),
      JSON.stringify({
        primary_languages: ["TypeScript"],
        all_directories: {},
      }),
    );

    // Create a TS file so the extractor finds something
    const srcDir = join(project.projectRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, "index.ts"),
      'export function main() { console.log("hello"); }\n',
    );

    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    expect(result.successCount).toBeGreaterThanOrEqual(1);

    // Skeleton output should exist
    const tsSkeletonExists = await fileExists(
      join(project.dataDir, "skeletons", "typescript.json"),
    );
    expect(tsSkeletonExists).toBe(true);
  });

  it("handles missing tool-availability.json gracefully", async () => {
    project = await createTestProject();
    // Don't create tool-availability.json

    const result = await runPreAnalysisTools({
      projectRoot: project.projectRoot,
    });

    // Should still complete without error
    expect(result).toHaveProperty("successCount");
    expect(result).toHaveProperty("failureCount");
  });
});

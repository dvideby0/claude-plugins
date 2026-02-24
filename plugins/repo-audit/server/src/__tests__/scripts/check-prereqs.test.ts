import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkPrereqs } from "../../scripts/check-prereqs.js";
import {
  createTestProject,
  type TestProject,
} from "../helpers.js";
import type { ToolAvailability } from "../../lib/types.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

describe("checkPrereqs", () => {
  it("produces valid JSON with all required fields", async () => {
    project = await createTestProject();

    const result = await checkPrereqs(project.projectRoot);

    expect(result).toHaveProperty("os");
    expect(result).toHaveProperty("package_manager");
    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("tools");
    expect(result).toHaveProperty("project_tools");
    expect(result).toHaveProperty("detected_languages");
    expect(result).toHaveProperty("install_commands");
  });

  it("detects OS (non-empty string)", async () => {
    project = await createTestProject();

    const result = await checkPrereqs(project.projectRoot);

    expect(result.os).toBeTruthy();
    expect(typeof result.os).toBe("string");
  });

  it("detects macos on Darwin platform", async () => {
    if (process.platform !== "darwin") return;

    project = await createTestProject();
    const result = await checkPrereqs(project.projectRoot);

    expect(result.os).toBe("macos");
    expect(result.package_manager).toBe("brew");
  });

  it("includes entries for core tools", async () => {
    project = await createTestProject();

    const result = await checkPrereqs(project.projectRoot);

    expect(result.tools).toHaveProperty("rg");
    expect(result.tools).toHaveProperty("tree");
    expect(result.tools).toHaveProperty("cloc");
    expect(result.tools).toHaveProperty("tokei");

    // Each tool entry has available boolean
    for (const [, info] of Object.entries(result.tools)) {
      expect(typeof info.available).toBe("boolean");
    }
  });

  it("detects tools that are actually installed", async () => {
    project = await createTestProject();

    const result = await checkPrereqs(project.projectRoot);

    // If a tool is available, it should have a path
    for (const [, info] of Object.entries(result.tools)) {
      if (info.available) {
        expect(info.path).toBeTruthy();
      }
    }
  });

  it("detects languages from project markers", async () => {
    project = await createTestProject();

    // Create Python and Node markers
    await writeFile(join(project.projectRoot, "pyproject.toml"), "");
    await writeFile(
      join(project.projectRoot, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    const result = await checkPrereqs(project.projectRoot);

    expect(result.detected_languages.python).toBe(true);
    expect(result.detected_languages.node).toBe(true);
    expect(result.detected_languages.rust).toBe(false);
    expect(result.detected_languages.go).toBe(false);
    expect(result.detected_languages.ruby).toBe(false);
  });

  it("detects Rust from Cargo.toml", async () => {
    project = await createTestProject();

    await writeFile(join(project.projectRoot, "Cargo.toml"), "");

    const result = await checkPrereqs(project.projectRoot);

    expect(result.detected_languages.rust).toBe(true);
  });

  it("detects Go from go.mod", async () => {
    project = await createTestProject();

    await writeFile(join(project.projectRoot, "go.mod"), "");

    const result = await checkPrereqs(project.projectRoot);

    expect(result.detected_languages.go).toBe(true);
  });

  it("detects Ruby from Gemfile", async () => {
    project = await createTestProject();

    await writeFile(join(project.projectRoot, "Gemfile"), "");

    const result = await checkPrereqs(project.projectRoot);

    expect(result.detected_languages.ruby).toBe(true);
  });

  it("detects no languages for empty project", async () => {
    project = await createTestProject();

    const result = await checkPrereqs(project.projectRoot);

    expect(result.detected_languages.python).toBe(false);
    expect(result.detected_languages.rust).toBe(false);
    expect(result.detected_languages.go).toBe(false);
    expect(result.detected_languages.ruby).toBe(false);
    expect(result.detected_languages.node).toBe(false);
  });

  it("checks project tools when Node is detected", async () => {
    project = await createTestProject();

    await writeFile(
      join(project.projectRoot, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    const result = await checkPrereqs(project.projectRoot);

    // Should have entries for node project tools
    expect(result.project_tools).toHaveProperty("tsc");
    expect(result.project_tools).toHaveProperty("eslint");
    expect(result.project_tools).toHaveProperty("biome");
  });

  it("provides install commands for missing tools", async () => {
    project = await createTestProject();

    const result = await checkPrereqs(project.projectRoot);

    // install_commands should have the right structure
    expect(result.install_commands).toHaveProperty("all_missing");
    expect(result.install_commands).toHaveProperty("per_tool");
    expect(typeof result.install_commands.per_tool).toBe("object");

    // If there are missing tools, per_tool should have entries
    if (result.install_commands.all_missing !== null) {
      expect(Object.keys(result.install_commands.per_tool).length).toBeGreaterThan(0);
    }
  });

  it("writes output file to correct location", async () => {
    project = await createTestProject();

    await checkPrereqs(project.projectRoot);

    const outputPath = join(project.dataDir, "tool-availability.json");
    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as ToolAvailability;

    expect(parsed).toHaveProperty("os");
    expect(parsed).toHaveProperty("tools");
  });

  it("produces valid ISO 8601 timestamp", async () => {
    project = await createTestProject();

    const result = await checkPrereqs(project.projectRoot);

    expect(result.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it("detects Python from multiple marker files", async () => {
    project = await createTestProject();

    // requirements.txt is another Python marker
    await writeFile(join(project.projectRoot, "requirements.txt"), "flask\n");

    const result = await checkPrereqs(project.projectRoot);

    expect(result.detected_languages.python).toBe(true);
  });

  it("checks Python project tools when Python detected", async () => {
    project = await createTestProject();

    await writeFile(join(project.projectRoot, "pyproject.toml"), "");

    const result = await checkPrereqs(project.projectRoot);

    expect(result.project_tools).toHaveProperty("ruff");
    expect(result.project_tools).toHaveProperty("mypy");
  });
});

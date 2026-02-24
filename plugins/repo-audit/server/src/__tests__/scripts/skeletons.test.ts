import { describe, it, expect, afterEach } from "vitest";
import { readFile, cp } from "node:fs/promises";
import { join } from "node:path";
import {
  extractTypescriptSkeletons,
  extractGoSkeletons,
  extractRustSkeletons,
  extractJavaSkeletons,
  extractPythonSkeletons,
} from "../../scripts/skeletons/index.js";
import { parseGrepOutput } from "../../scripts/skeletons/common.js";
import {
  createTestProject,
  FIXTURES_DIR,
  type TestProject,
} from "../helpers.js";

const SKELETON_SOURCES = join(FIXTURES_DIR, "skeleton-sources");

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

/**
 * Copy skeleton source fixtures into a test project.
 */
async function setupSkeletonProject(): Promise<TestProject> {
  const p = await createTestProject();
  // Copy fixture source files into project root
  await cp(SKELETON_SOURCES, p.projectRoot, { recursive: true });
  return p;
}

async function readSkeletonOutput(
  projectRoot: string,
  filename: string,
): Promise<Record<string, any>> {
  const path = join(projectRoot, "sdlc-audit", "data", "skeletons", filename);
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}

// ---- Common framework tests ----

describe("parseGrepOutput", () => {
  it("parses standard file:line:content format", () => {
    const output = [
      "/tmp/project/src/foo.ts:10:export function bar() {",
      "/tmp/project/src/baz.ts:25:import { x } from 'y'",
    ].join("\n");

    const matches = parseGrepOutput(output);
    expect(matches).toHaveLength(2);
    expect(matches[0].file).toBe("/tmp/project/src/foo.ts");
    expect(matches[0].line).toBe(10);
    expect(matches[0].content).toBe("export function bar() {");
    expect(matches[1].file).toBe("/tmp/project/src/baz.ts");
    expect(matches[1].line).toBe(25);
  });

  it("skips blank lines", () => {
    const output = "/tmp/a.ts:1:x\n\n/tmp/b.ts:2:y\n";
    const matches = parseGrepOutput(output);
    expect(matches).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(parseGrepOutput("")).toHaveLength(0);
    expect(parseGrepOutput("\n")).toHaveLength(0);
  });
});

// ---- TypeScript extractor ----

describe("extractTypescriptSkeletons", () => {
  it("extracts exports, imports, and functions from TS files", async () => {
    project = await setupSkeletonProject();
    const result = await extractTypescriptSkeletons(project.projectRoot);

    expect(result.fileCount).toBeGreaterThan(0);

    const data = await readSkeletonOutput(project.projectRoot, "typescript.json");
    const loginFile = data["src/auth/login.ts"];
    expect(loginFile).toBeDefined();

    // Exports
    expect(loginFile.exports).toContainEqual(expect.stringContaining("handleLogin"));
    expect(loginFile.exports).toContainEqual(expect.stringContaining("AuthService"));
    expect(loginFile.exports).toContainEqual(expect.stringContaining("MAX_RETRIES"));

    // Imports
    expect(loginFile.imports).toContainEqual("express");
    expect(loginFile.imports).toContainEqual("../utils/jwt");

    // Functions
    expect(loginFile.functions).toContain("handleLogin");
    expect(loginFile.functions).toContain("hashPassword");

    // Line count
    expect(loginFile.line_count).toBeGreaterThan(0);
  });

  it("writes empty JSON for project with no TS files", async () => {
    project = await createTestProject();
    const result = await extractTypescriptSkeletons(project.projectRoot);

    expect(result.fileCount).toBe(0);

    const data = await readSkeletonOutput(project.projectRoot, "typescript.json");
    expect(Object.keys(data)).toHaveLength(0);
  });
});

// ---- Go extractor ----

describe("extractGoSkeletons", () => {
  it("extracts package, imports, functions, and types from Go files", async () => {
    project = await setupSkeletonProject();
    const result = await extractGoSkeletons(project.projectRoot);

    expect(result.fileCount).toBeGreaterThan(0);

    const data = await readSkeletonOutput(project.projectRoot, "go.json");
    const helpersFile = data["src/utils/helpers.go"];
    expect(helpersFile).toBeDefined();

    expect(helpersFile.package).toBe("utils");

    // Imports (block import)
    expect(helpersFile.imports).toContain("fmt");
    expect(helpersFile.imports).toContain("strings");

    // Functions
    expect(helpersFile.functions).toContain("NewConfig");
    expect(helpersFile.functions).toContain("String");
    expect(helpersFile.functions).toContain("ParseArgs");

    // Types
    expect(helpersFile.types).toContainEqual("Config (struct)");
    expect(helpersFile.types).toContainEqual("Logger (interface)");

    expect(helpersFile.line_count).toBeGreaterThan(0);
  });

  it("writes empty JSON for project with no Go files", async () => {
    project = await createTestProject();
    const result = await extractGoSkeletons(project.projectRoot);

    expect(result.fileCount).toBe(0);

    const data = await readSkeletonOutput(project.projectRoot, "go.json");
    expect(Object.keys(data)).toHaveLength(0);
  });
});

// ---- Rust extractor ----

describe("extractRustSkeletons", () => {
  it("extracts uses, functions, structs, enums, and traits from Rust files", async () => {
    project = await setupSkeletonProject();
    const result = await extractRustSkeletons(project.projectRoot);

    expect(result.fileCount).toBeGreaterThan(0);

    const data = await readSkeletonOutput(project.projectRoot, "rust.json");
    const handlerFile = data["src/auth/handler.rs"];
    expect(handlerFile).toBeDefined();

    // Uses
    expect(handlerFile.uses).toContain("std::collections::HashMap");
    expect(handlerFile.uses).toContain("crate::config::Settings");

    // Functions
    expect(handlerFile.functions).toContain("handle_login");
    expect(handlerFile.functions).toContain("hash_password");

    // Structs
    expect(handlerFile.structs).toContain("AuthHandler");

    // Enums
    expect(handlerFile.enums).toContain("AuthError");

    // Traits
    expect(handlerFile.traits).toContain("Authenticator");

    expect(handlerFile.line_count).toBeGreaterThan(0);
  });

  it("writes empty JSON for project with no Rust files", async () => {
    project = await createTestProject();
    const result = await extractRustSkeletons(project.projectRoot);

    expect(result.fileCount).toBe(0);

    const data = await readSkeletonOutput(project.projectRoot, "rust.json");
    expect(Object.keys(data)).toHaveLength(0);
  });
});

// ---- Java extractor ----

describe("extractJavaSkeletons", () => {
  it("extracts package, imports, classes, and methods from Java files", async () => {
    project = await setupSkeletonProject();
    const result = await extractJavaSkeletons(project.projectRoot);

    expect(result.fileCount).toBeGreaterThan(0);

    const data = await readSkeletonOutput(project.projectRoot, "java.json");
    const loginFile = data["src/auth/LoginService.java"];
    expect(loginFile).toBeDefined();

    expect(loginFile.package).toBe("com.example.auth");

    // Imports
    expect(loginFile.imports).toContain("java.util.Map");
    expect(loginFile.imports).toContain("java.util.HashMap");

    // Classes
    expect(loginFile.classes).toContainEqual("LoginService (class)");
    expect(loginFile.classes).toContainEqual("AuthProvider (interface)");
    expect(loginFile.classes).toContainEqual("AuthRole (enum)");

    // Methods
    expect(loginFile.methods).toContain("authenticate");
    expect(loginFile.methods).toContain("validatePassword");

    expect(loginFile.line_count).toBeGreaterThan(0);
  });

  it("writes empty JSON for project with no Java files", async () => {
    project = await createTestProject();
    const result = await extractJavaSkeletons(project.projectRoot);

    expect(result.fileCount).toBe(0);

    const data = await readSkeletonOutput(project.projectRoot, "java.json");
    expect(Object.keys(data)).toHaveLength(0);
  });
});

// ---- Python extractor ----

describe("extractPythonSkeletons", () => {
  it("extracts functions, classes, and imports from Python files", async () => {
    project = await setupSkeletonProject();

    // Check python3 is available
    let python3Available = true;
    try {
      const { execSync } = await import("node:child_process");
      execSync("which python3", { stdio: "ignore" });
    } catch {
      python3Available = false;
    }

    if (!python3Available) {
      // Skip test on systems without python3
      return;
    }

    const result = await extractPythonSkeletons(project.projectRoot);

    expect(result.fileCount).toBeGreaterThan(0);

    const data = await readSkeletonOutput(project.projectRoot, "python.json");
    const helpersFile = data["src/utils/helpers.py"];
    expect(helpersFile).toBeDefined();

    // Functions
    const funcNames = helpersFile.functions.map((f: any) => f.name);
    expect(funcNames).toContain("parse_config");
    expect(funcNames).toContain("fetch_data");

    // Async function detection
    const fetchData = helpersFile.functions.find((f: any) => f.name === "fetch_data");
    expect(fetchData.is_async).toBe(true);

    // Classes
    const classNames = helpersFile.classes.map((c: any) => c.name);
    expect(classNames).toContain("ConfigParser");
    expect(classNames).toContain("ValidationError");

    // Class methods
    const parser = helpersFile.classes.find((c: any) => c.name === "ConfigParser");
    expect(parser.methods).toContain("__init__");
    expect(parser.methods).toContain("read");
    expect(parser.methods).toContain("write");

    // Imports
    const importFroms = helpersFile.imports.map((i: any) => i.from);
    expect(importFroms).toContain("typing");
    expect(importFroms).toContain("pathlib");

    expect(helpersFile.line_count).toBeGreaterThan(0);
  });

  it("writes empty JSON when python3 unavailable or no .py files", async () => {
    project = await createTestProject();
    const result = await extractPythonSkeletons(project.projectRoot);

    // Either 0 files found or python3 unavailable — both produce empty output
    const data = await readSkeletonOutput(project.projectRoot, "python.json");
    expect(Object.keys(data)).toHaveLength(0);
  });
});

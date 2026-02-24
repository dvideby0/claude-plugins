/**
 * Test utilities for repo-audit script migration tests.
 *
 * Mirrors the bash test pattern: create tmp project dir, copy fixtures,
 * run function under test, assert on output files/return values.
 */

import { mkdtemp, cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to existing bash test fixtures (reused by Vitest tests). */
export const FIXTURES_DIR = join(__dirname, "..", "..", "..", "tests", "fixtures");

/** Path to module fixtures specifically. */
export const MODULE_FIXTURES_DIR = join(FIXTURES_DIR, "modules");

export interface TestProject {
  /** Root of the temporary project directory. */
  projectRoot: string;
  /** Path to sdlc-audit/ within the project. */
  auditDir: string;
  /** Path to sdlc-audit/modules/ */
  modulesDir: string;
  /** Path to sdlc-audit/data/ */
  dataDir: string;
  /** Path to sdlc-audit/reports/ */
  reportsDir: string;
  /** Path to sdlc-audit/tool-output/ */
  toolOutputDir: string;
  /** Remove the temporary directory. Call in afterEach/afterAll. */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated temporary project with the standard sdlc-audit directory
 * structure. Returns paths and a cleanup function.
 */
export async function createTestProject(): Promise<TestProject> {
  const projectRoot = await mkdtemp(join(tmpdir(), "repo-audit-test-"));
  const auditDir = join(projectRoot, "sdlc-audit");
  const modulesDir = join(auditDir, "modules");
  const dataDir = join(auditDir, "data");
  const reportsDir = join(auditDir, "reports");
  const toolOutputDir = join(auditDir, "tool-output");

  await mkdir(modulesDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await mkdir(toolOutputDir, { recursive: true });

  return {
    projectRoot,
    auditDir,
    modulesDir,
    dataDir,
    reportsDir,
    toolOutputDir,
    cleanup: () => rm(projectRoot, { recursive: true, force: true }),
  };
}

/**
 * Copy a fixture file into a destination directory.
 * @param fixtureName Filename relative to MODULE_FIXTURES_DIR (e.g. "src_api.json")
 * @param destDir Destination directory path
 * @returns Full path to the copied file
 */
export async function copyFixture(
  fixtureName: string,
  destDir: string,
): Promise<string> {
  const src = join(MODULE_FIXTURES_DIR, fixtureName);
  const dest = join(destDir, fixtureName);
  await cp(src, dest);
  return dest;
}

/**
 * Copy a non-module fixture file (from the fixtures root, not modules/).
 */
export async function copyRootFixture(
  fixtureName: string,
  destDir: string,
): Promise<string> {
  const src = join(FIXTURES_DIR, fixtureName);
  const dest = join(destDir, fixtureName);
  await cp(src, dest);
  return dest;
}

/**
 * Read and parse a JSON file with type safety.
 */
export async function readJsonOutput<T>(filePath: string): Promise<T> {
  const data = await readFile(filePath, "utf-8");
  return JSON.parse(data) as T;
}

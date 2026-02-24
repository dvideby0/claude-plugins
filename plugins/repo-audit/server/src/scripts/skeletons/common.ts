/**
 * Shared framework for skeleton extraction across languages.
 *
 * Each language extractor defines patterns and post-processing,
 * then uses this framework to run rg/grep and build output JSON.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { runScript } from "../../lib/subprocess.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface PatternDef {
  label: string;
  pattern: string;
}

export interface LanguageConfig {
  name: string;
  outputFile: string;
  rgType?: string;
  rgTypeAdd?: string;
  grepIncludes: string[];
  excludeGlobs: string[];
  excludeDirsRegex: string;
}

export interface ExtractionResult {
  fileCount: number;
  errorCount: number;
}

// ---------------------------------------------------------------------------
// rg availability check (cached)
// ---------------------------------------------------------------------------

let rgAvailable: boolean | null = null;

export async function checkRgAvailable(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await runScript("which", ["rg"], { timeout: 5000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** Reset cache — useful for testing. */
export function resetRgCache(): void {
  rgAvailable = null;
}

// ---------------------------------------------------------------------------
// Grep execution
// ---------------------------------------------------------------------------

/**
 * Run a regex search using rg (preferred) or grep (fallback).
 * Returns parsed matches as {file, line, content}.
 */
export async function runGrep(
  pattern: string,
  config: LanguageConfig,
  projectRoot: string,
): Promise<GrepMatch[]> {
  const useRg = await checkRgAvailable();

  let stdout: string;

  if (useRg) {
    const args = ["-n", "--no-heading"];

    if (config.rgTypeAdd) {
      args.push("--type-add", config.rgTypeAdd);
    }
    if (config.rgType) {
      args.push("--type", config.rgType);
    }

    for (const glob of config.excludeGlobs) {
      args.push("--glob", `!${glob}`);
    }

    args.push(pattern, projectRoot);

    try {
      const result = await runScript("rg", args, {
        cwd: projectRoot,
        timeout: 30_000,
      });
      stdout = result.stdout;
    } catch {
      return [];
    }
  } else {
    const args = ["-rnE"];

    for (const inc of config.grepIncludes) {
      args.push(`--include=${inc}`);
    }

    args.push(pattern, projectRoot);

    try {
      const result = await runScript("grep", args, {
        cwd: projectRoot,
        timeout: 30_000,
      });
      stdout = result.stdout;
    } catch {
      return [];
    }

    // Apply exclude filter for grep (rg handles this via --glob)
    if (config.excludeDirsRegex) {
      const excludeRe = new RegExp(`(${config.excludeDirsRegex})/`);
      stdout = stdout
        .split("\n")
        .filter((line) => !excludeRe.test(line))
        .join("\n");
    }
  }

  return parseGrepOutput(stdout);
}

/**
 * Parse grep/rg output in "file:line:content" format into structured matches.
 */
export function parseGrepOutput(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    // Format: /abs/path/to/file.ts:42:matched content here
    // Need to handle paths with colons carefully — line number is always numeric
    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;

    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;

    const file = line.slice(0, firstColon);
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    const content = line.slice(secondColon + 1);

    if (isNaN(lineNum)) continue;

    matches.push({ file, line: lineNum, content });
  }

  return matches;
}

/**
 * Group matches by file path, returning a Map from absolute path to matches.
 */
export function groupByFile(matches: GrepMatch[]): Map<string, GrepMatch[]> {
  const grouped = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const existing = grouped.get(m.file);
    if (existing) {
      existing.push(m);
    } else {
      grouped.set(m.file, [m]);
    }
  }
  return grouped;
}

/**
 * Count lines in a file.
 */
export async function countFileLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Make a path relative to the project root.
 */
export function toRelativePath(
  absPath: string,
  projectRoot: string,
): string {
  return relative(projectRoot, absPath);
}

/**
 * Write skeleton output JSON to the standard location.
 */
export async function writeSkeletonOutput(
  projectRoot: string,
  outputFile: string,
  data: Record<string, unknown>,
): Promise<void> {
  const outputDir = join(projectRoot, "sdlc-audit", "data", "skeletons");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, outputFile), JSON.stringify(data, null, 2));
}

/**
 * Collect all unique file paths from multiple match arrays.
 */
export function collectAllFiles(
  ...matchArrays: GrepMatch[][]
): Set<string> {
  const files = new Set<string>();
  for (const matches of matchArrays) {
    for (const m of matches) {
      files.add(m.file);
    }
  }
  return files;
}

/**
 * Apply a regex post-process to extract a value from matched content.
 * Returns the first capture group, or null if no match.
 */
export function extractWithRegex(
  content: string,
  regex: RegExp,
): string | null {
  const m = content.match(regex);
  return m ? (m[1] ?? m[0]) : null;
}

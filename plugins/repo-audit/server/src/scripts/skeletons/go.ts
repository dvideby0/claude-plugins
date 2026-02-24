/**
 * Extract Go code skeletons.
 * Migrated from scripts/extract-skeletons-go.sh.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runScript } from "../../lib/subprocess.js";
import {
  runGrep,
  checkRgAvailable,
  groupByFile,
  countFileLines,
  toRelativePath,
  writeSkeletonOutput,
  collectAllFiles,
  type LanguageConfig,
  type GrepMatch,
  type ExtractionResult,
} from "./common.js";

const CONFIG: LanguageConfig = {
  name: "go",
  outputFile: "go.json",
  rgType: "go",
  grepIncludes: ["*.go"],
  excludeGlobs: [
    "vendor", ".git", "sdlc-audit", "node_modules", "dist", "build", "target",
  ],
  excludeDirsRegex: "vendor|\\.git|sdlc-audit|node_modules|dist|build|target",
};

const PATTERNS = {
  packages: String.raw`^package\s+\w+`,
  imports: String.raw`^import\s+`,
  functions: String.raw`^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(`,
  types: String.raw`^type\s+\w+\s+(struct|interface)`,
};

const PACKAGE_NAME = /^package\s+(\w+)/;
const FUNC_NAME = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/;
const TYPE_EXTRACT = /^type\s+(\w+)\s+(struct|interface)/;
const IMPORT_PATH = /"([^"]+)"/;

/**
 * Extract multi-line import block paths from Go files.
 * Go allows `import ( "fmt"\n "os" )` blocks.
 */
async function extractBlockImports(
  projectRoot: string,
): Promise<GrepMatch[]> {
  const useRg = await checkRgAvailable();
  let fileList: string[];

  try {
    if (useRg) {
      const result = await runScript("rg", [
        "-l", "--type", "go",
        "--glob", "!vendor", "--glob", "!.git", "--glob", "!sdlc-audit",
        "import \\(", projectRoot,
      ], { cwd: projectRoot, timeout: 15_000 });
      fileList = result.stdout.trim().split("\n").filter(Boolean);
    } else {
      const result = await runScript("grep", [
        "-rlE", "--include=*.go", "import \\(", projectRoot,
      ], { cwd: projectRoot, timeout: 15_000 });
      fileList = result.stdout.trim().split("\n").filter(Boolean);
      const excludeRe = new RegExp(`(${CONFIG.excludeDirsRegex})/`);
      fileList = fileList.filter((f) => !excludeRe.test(f));
    }
  } catch {
    return [];
  }

  const matches: GrepMatch[] = [];

  for (const filepath of fileList) {
    try {
      const content = await readFile(filepath, "utf-8");
      let inBlock = false;

      for (const line of content.split("\n")) {
        if (/^import\s*\(/.test(line)) {
          inBlock = true;
          continue;
        }
        if (inBlock && /^\)/.test(line.trim())) {
          inBlock = false;
          continue;
        }
        if (inBlock) {
          const pathMatch = line.match(IMPORT_PATH);
          if (pathMatch) {
            matches.push({ file: filepath, line: 0, content: pathMatch[1] });
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return matches;
}

export async function extractGoSkeletons(
  projectRoot: string,
): Promise<ExtractionResult> {
  const [packageMatches, importMatches, functionMatches, typeMatches, blockImports] =
    await Promise.all([
      runGrep(PATTERNS.packages, CONFIG, projectRoot),
      runGrep(PATTERNS.imports, CONFIG, projectRoot),
      runGrep(PATTERNS.functions, CONFIG, projectRoot),
      runGrep(PATTERNS.types, CONFIG, projectRoot),
      extractBlockImports(projectRoot),
    ]);

  const allFiles = collectAllFiles(
    packageMatches, importMatches, functionMatches, typeMatches, blockImports,
  );

  if (allFiles.size === 0) {
    await writeSkeletonOutput(projectRoot, CONFIG.outputFile, {});
    return { fileCount: 0, errorCount: 0 };
  }

  const packagesByFile = groupByFile(packageMatches);
  const importsByFile = groupByFile(importMatches);
  const functionsByFile = groupByFile(functionMatches);
  const typesByFile = groupByFile(typeMatches);
  const blockImportsByFile = groupByFile(blockImports);

  const result: Record<string, unknown> = {};
  let errorCount = 0;

  for (const absPath of allFiles) {
    try {
      const relPath = toRelativePath(absPath, projectRoot);
      const lineCount = await countFileLines(absPath);

      // Package
      const pkgMatches = packagesByFile.get(absPath) ?? [];
      let pkg = "";
      if (pkgMatches.length > 0) {
        const m = pkgMatches[0].content.trim().match(PACKAGE_NAME);
        if (m) pkg = m[1];
      }

      // Imports: combine single-line and block imports, deduplicate
      const singleImports: string[] = [];
      for (const m of importsByFile.get(absPath) ?? []) {
        const pathMatch = m.content.match(IMPORT_PATH);
        if (pathMatch) singleImports.push(pathMatch[1]);
      }
      const blockImps = (blockImportsByFile.get(absPath) ?? []).map((m) => m.content);
      const allImports = [...new Set([...singleImports, ...blockImps])].sort();

      // Functions
      const functions: string[] = [];
      for (const m of functionsByFile.get(absPath) ?? []) {
        const nameMatch = m.content.trim().match(FUNC_NAME);
        if (nameMatch) functions.push(nameMatch[1]);
      }

      // Types
      const types: string[] = [];
      for (const m of typesByFile.get(absPath) ?? []) {
        const typeMatch = m.content.trim().match(TYPE_EXTRACT);
        if (typeMatch) types.push(`${typeMatch[1]} (${typeMatch[2]})`);
      }

      result[relPath] = {
        package: pkg,
        imports: allImports,
        functions: [...new Set(functions)],
        types: [...new Set(types)],
        line_count: lineCount,
      };
    } catch {
      errorCount++;
    }
  }

  await writeSkeletonOutput(projectRoot, CONFIG.outputFile, result);
  return { fileCount: allFiles.size - errorCount, errorCount };
}

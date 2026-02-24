/**
 * Extract TypeScript/JavaScript code skeletons.
 * Migrated from scripts/extract-skeletons-ts.sh.
 */

import {
  runGrep,
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
  name: "typescript",
  outputFile: "typescript.json",
  rgType: "tsjs",
  rgTypeAdd: "tsjs:*.{ts,tsx,js,jsx}",
  grepIncludes: ["*.ts", "*.tsx", "*.js", "*.jsx"],
  excludeGlobs: [
    "node_modules", "dist", "build", ".next", "sdlc-audit",
    ".git", "coverage", "__pycache__", ".venv", "venv", "target", "vendor", "obj",
  ],
  excludeDirsRegex:
    "node_modules|dist|build|\\.next|sdlc-audit|\\.git|coverage|__pycache__|\\.venv|venv|target|vendor|obj",
};

// Regex patterns matching the bash script
const PATTERNS = {
  exports: String.raw`^export\s+(default\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\s+\w+`,
  imports: String.raw`^import\s+`,
  functions: String.raw`(export\s+)?(async\s+)?function\s+\w+`,
  classes: String.raw`(export\s+)?class\s+\w+`,
};

// Post-processing regexes
const EXPORT_EXTRACT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/;
const EXPORT_TYPE =
  /^export\s+(?:default\s+)?(?:async\s+)?(function|const|let|var|class|interface|type|enum)\s+/;
const IMPORT_SOURCE = /from\s+['"]([^'"]+)['"]/;
const FUNCTION_NAME = /(?:async\s+)?function\s+(\w+)/;

function extractExport(content: string): string | null {
  const trimmed = content.trim();
  const nameMatch = trimmed.match(EXPORT_EXTRACT);
  const typeMatch = trimmed.match(EXPORT_TYPE);
  if (nameMatch && typeMatch) {
    return `${nameMatch[1]} (${typeMatch[1]})`;
  }
  return null;
}

function extractImportSource(content: string): string | null {
  const m = content.match(IMPORT_SOURCE);
  return m ? m[1] : null;
}

function extractFunctionName(content: string): string | null {
  const m = content.match(FUNCTION_NAME);
  return m ? m[1] : null;
}

function processMatches(
  matches: GrepMatch[],
  extractor: (content: string) => string | null,
): string[] {
  const results: string[] = [];
  for (const m of matches) {
    const extracted = extractor(m.content.trim());
    if (extracted) results.push(extracted);
  }
  return [...new Set(results)];
}

export async function extractTypescriptSkeletons(
  projectRoot: string,
): Promise<ExtractionResult> {
  const [exportMatches, importMatches, functionMatches] = await Promise.all([
    runGrep(PATTERNS.exports, CONFIG, projectRoot),
    runGrep(PATTERNS.imports, CONFIG, projectRoot),
    runGrep(PATTERNS.functions, CONFIG, projectRoot),
  ]);

  const allFiles = collectAllFiles(exportMatches, importMatches, functionMatches);

  if (allFiles.size === 0) {
    await writeSkeletonOutput(projectRoot, CONFIG.outputFile, {});
    return { fileCount: 0, errorCount: 0 };
  }

  const exportsByFile = groupByFile(exportMatches);
  const importsByFile = groupByFile(importMatches);
  const functionsByFile = groupByFile(functionMatches);

  const result: Record<string, unknown> = {};
  let errorCount = 0;

  for (const absPath of allFiles) {
    try {
      const relPath = toRelativePath(absPath, projectRoot);
      const lineCount = await countFileLines(absPath);

      result[relPath] = {
        exports: processMatches(exportsByFile.get(absPath) ?? [], extractExport),
        imports: processMatches(importsByFile.get(absPath) ?? [], extractImportSource),
        functions: processMatches(functionsByFile.get(absPath) ?? [], extractFunctionName),
        line_count: lineCount,
      };
    } catch {
      errorCount++;
    }
  }

  await writeSkeletonOutput(projectRoot, CONFIG.outputFile, result);
  return { fileCount: allFiles.size - errorCount, errorCount };
}

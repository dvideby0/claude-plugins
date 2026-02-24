/**
 * Extract Java code skeletons.
 * Migrated from scripts/extract-skeletons-java.sh.
 */

import {
  runGrep,
  groupByFile,
  countFileLines,
  toRelativePath,
  writeSkeletonOutput,
  collectAllFiles,
  type LanguageConfig,
  type ExtractionResult,
} from "./common.js";

const CONFIG: LanguageConfig = {
  name: "java",
  outputFile: "java.json",
  rgType: "java",
  grepIncludes: ["*.java"],
  excludeGlobs: [
    ".git", "sdlc-audit", "node_modules", "dist", "build",
    "target", "vendor", ".gradle", ".idea", "out",
  ],
  excludeDirsRegex:
    "\\.git|sdlc-audit|node_modules|dist|build|target|vendor|\\.gradle|\\.idea|out",
};

const PATTERNS = {
  packages: String.raw`^\s*package\s+`,
  imports: String.raw`^\s*import\s+`,
  classes: String.raw`(public|protected|private)?\s*(abstract\s+)?(static\s+)?(final\s+)?(class|interface|enum)\s+\w+`,
  methods: String.raw`(public|protected|private)\s+(static\s+)?(final\s+)?[\w<>\[\], ]+\s+\w+\s*\(`,
};

const PACKAGE_NAME = /^\s*package\s+([^;]+)/;
const IMPORT_NAME = /^\s*import\s+(?:static\s+)?([^;]+)/;
const CLASS_EXTRACT = /(class|interface|enum)\s+(\w+)/;
const METHOD_NAME =
  /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:[\w<>\[\], ]+)\s+(\w+)\s*\(/;

// Keywords that the method regex can accidentally match
const METHOD_EXCLUDE = new Set([
  "class", "interface", "enum", "if", "for", "while", "switch", "return", "new",
]);

export async function extractJavaSkeletons(
  projectRoot: string,
): Promise<ExtractionResult> {
  const [packageMatches, importMatches, classMatches, methodMatches] =
    await Promise.all([
      runGrep(PATTERNS.packages, CONFIG, projectRoot),
      runGrep(PATTERNS.imports, CONFIG, projectRoot),
      runGrep(PATTERNS.classes, CONFIG, projectRoot),
      runGrep(PATTERNS.methods, CONFIG, projectRoot),
    ]);

  const allFiles = collectAllFiles(
    packageMatches, importMatches, classMatches, methodMatches,
  );

  if (allFiles.size === 0) {
    await writeSkeletonOutput(projectRoot, CONFIG.outputFile, {});
    return { fileCount: 0, errorCount: 0 };
  }

  const packagesByFile = groupByFile(packageMatches);
  const importsByFile = groupByFile(importMatches);
  const classesByFile = groupByFile(classMatches);
  const methodsByFile = groupByFile(methodMatches);

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
        if (m) pkg = m[1].trim();
      }

      // Imports
      const imports: string[] = [];
      for (const m of importsByFile.get(absPath) ?? []) {
        const match = m.content.trim().match(IMPORT_NAME);
        if (match) imports.push(match[1].trim());
      }

      // Classes / interfaces / enums
      const classes: string[] = [];
      for (const m of classesByFile.get(absPath) ?? []) {
        const match = m.content.match(CLASS_EXTRACT);
        if (match) classes.push(`${match[2]} (${match[1]})`);
      }

      // Methods (excluding false positives from keywords)
      const methods: string[] = [];
      for (const m of methodsByFile.get(absPath) ?? []) {
        const match = m.content.trim().match(METHOD_NAME);
        if (match && !METHOD_EXCLUDE.has(match[1])) {
          methods.push(match[1]);
        }
      }

      result[relPath] = {
        package: pkg,
        imports: [...new Set(imports)],
        classes: [...new Set(classes)],
        methods: [...new Set(methods)],
        line_count: lineCount,
      };
    } catch {
      errorCount++;
    }
  }

  await writeSkeletonOutput(projectRoot, CONFIG.outputFile, result);
  return { fileCount: allFiles.size - errorCount, errorCount };
}

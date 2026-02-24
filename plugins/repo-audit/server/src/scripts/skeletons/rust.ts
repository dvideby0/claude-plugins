/**
 * Extract Rust code skeletons.
 * Migrated from scripts/extract-skeletons-rust.sh.
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
  name: "rust",
  outputFile: "rust.json",
  rgType: "rust",
  grepIncludes: ["*.rs"],
  excludeGlobs: [
    "target", ".git", "sdlc-audit", "node_modules", "dist", "build", "vendor",
  ],
  excludeDirsRegex: "target|\\.git|sdlc-audit|node_modules|dist|build|vendor",
};

const PATTERNS = {
  uses: String.raw`^use\s+`,
  functions: String.raw`^(pub\s+)?(async\s+)?fn\s+\w+`,
  structs: String.raw`^(pub\s+)?struct\s+\w+`,
  enums: String.raw`^(pub\s+)?enum\s+\w+`,
  traits: String.raw`^(pub\s+)?trait\s+\w+`,
};

const USE_EXTRACT = /^use\s+(.+?)\s*;\s*$/;
const FN_NAME = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/;
const STRUCT_NAME = /^(?:pub\s+)?struct\s+(\w+)/;
const ENUM_NAME = /^(?:pub\s+)?enum\s+(\w+)/;
const TRAIT_NAME = /^(?:pub\s+)?trait\s+(\w+)/;

export async function extractRustSkeletons(
  projectRoot: string,
): Promise<ExtractionResult> {
  const [useMatches, fnMatches, structMatches, enumMatches, traitMatches] =
    await Promise.all([
      runGrep(PATTERNS.uses, CONFIG, projectRoot),
      runGrep(PATTERNS.functions, CONFIG, projectRoot),
      runGrep(PATTERNS.structs, CONFIG, projectRoot),
      runGrep(PATTERNS.enums, CONFIG, projectRoot),
      runGrep(PATTERNS.traits, CONFIG, projectRoot),
    ]);

  const allFiles = collectAllFiles(
    useMatches, fnMatches, structMatches, enumMatches, traitMatches,
  );

  if (allFiles.size === 0) {
    await writeSkeletonOutput(projectRoot, CONFIG.outputFile, {});
    return { fileCount: 0, errorCount: 0 };
  }

  const usesByFile = groupByFile(useMatches);
  const fnsByFile = groupByFile(fnMatches);
  const structsByFile = groupByFile(structMatches);
  const enumsByFile = groupByFile(enumMatches);
  const traitsByFile = groupByFile(traitMatches);

  const result: Record<string, unknown> = {};
  let errorCount = 0;

  for (const absPath of allFiles) {
    try {
      const relPath = toRelativePath(absPath, projectRoot);
      const lineCount = await countFileLines(absPath);

      const uses: string[] = [];
      for (const m of usesByFile.get(absPath) ?? []) {
        const match = m.content.trim().match(USE_EXTRACT);
        if (match) uses.push(match[1]);
      }

      const functions: string[] = [];
      for (const m of fnsByFile.get(absPath) ?? []) {
        const match = m.content.trim().match(FN_NAME);
        if (match) functions.push(match[1]);
      }

      const structs: string[] = [];
      for (const m of structsByFile.get(absPath) ?? []) {
        const match = m.content.trim().match(STRUCT_NAME);
        if (match) structs.push(match[1]);
      }

      const enums: string[] = [];
      for (const m of enumsByFile.get(absPath) ?? []) {
        const match = m.content.trim().match(ENUM_NAME);
        if (match) enums.push(match[1]);
      }

      const traits: string[] = [];
      for (const m of traitsByFile.get(absPath) ?? []) {
        const match = m.content.trim().match(TRAIT_NAME);
        if (match) traits.push(match[1]);
      }

      result[relPath] = {
        uses: [...new Set(uses)],
        functions: [...new Set(functions)],
        structs: [...new Set(structs)],
        enums: [...new Set(enums)],
        traits: [...new Set(traits)],
        line_count: lineCount,
      };
    } catch {
      errorCount++;
    }
  }

  await writeSkeletonOutput(projectRoot, CONFIG.outputFile, result);
  return { fileCount: allFiles.size - errorCount, errorCount };
}

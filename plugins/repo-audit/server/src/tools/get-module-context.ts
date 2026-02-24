import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { getState } from "../lib/state.js";
import { estimateTokens, fitsInBudget } from "../lib/tokens.js";

// ----- Interfaces -----

interface GetModuleContextInput {
  assignmentId: string;
  tokenBudget?: number;
}

interface GetModuleContextResult {
  assignmentId: string;
  taskPrompt: string;
  tokenEstimate: number;
  filesIncluded: number;
  filesSkeletonOnly: number;
  outputPath: string;
  validationCommand: string;
}

// ----- Sub-agent task template -----

function buildTaskPrompt(params: {
  directories: string[];
  category: string;
  languages: string[];
  guideContent: string;
  skeletonContent: string;
  prescanContent: string;
  linterContent: string;
  typecheckContent: string;
  sourceFiles: string;
  outputPath: string;
  pluginRoot: string;
}): string {
  const parts: string[] = [];

  parts.push(`You are analyzing: ${params.directories.join(", ")}`);
  parts.push(`Category: ${params.category}`);
  parts.push(`Languages in these directories: ${params.languages.join(", ")}`);
  parts.push("");

  // Language guide
  if (params.guideContent) {
    parts.push("=== LANGUAGE GUIDE (only for languages present in your directories) ===");
    parts.push(params.guideContent);
    parts.push("=== END LANGUAGE GUIDE ===");
    parts.push("");
  }

  // Skeleton data
  if (params.skeletonContent) {
    parts.push("=== FILE SKELETONS (structural data extracted by deterministic tools) ===");
    parts.push(params.skeletonContent);
    parts.push("=== END SKELETONS ===");
    parts.push("");
  }

  // Prescan findings
  if (params.prescanContent) {
    parts.push("=== PRE-SCAN FINDINGS (grep-detected patterns — confidence: high) ===");
    parts.push(params.prescanContent);
    parts.push("=== END PRE-SCAN ===");
    parts.push("");
  }

  // Linter results
  if (params.linterContent) {
    parts.push("=== LINTER RESULTS (from repo's own tools — confidence: definite) ===");
    parts.push(params.linterContent);
    parts.push("=== END LINTER RESULTS ===");
    parts.push("");
    parts.push("Do NOT re-report issues already captured by linters unless you have additional");
    parts.push("context. Focus on: architectural concerns, semantic bugs, cross-file patterns,");
    parts.push("DRY violations, and issues that require understanding intent.");
    parts.push("");
  }

  // Type check results
  if (params.typecheckContent) {
    parts.push("=== TYPE CHECK RESULTS (confidence: definite) ===");
    parts.push(params.typecheckContent);
    parts.push("=== END TYPE CHECK ===");
    parts.push("");
    parts.push("Type errors from the compiler are authoritative. Analyze whether they reveal");
    parts.push("deeper design problems or patterns (e.g., same type mismatch in 20 places");
    parts.push("= missing abstraction).");
    parts.push("");
  }

  // Source files
  if (params.sourceFiles) {
    parts.push("=== SOURCE FILES ===");
    parts.push(params.sourceFiles);
    parts.push("=== END SOURCE FILES ===");
    parts.push("");
  }

  // Instructions
  parts.push("Read EVERY file in your assigned directory/directories recursively.");
  parts.push("Do not skip any file. If a file is too large to read fully (> 1000 lines),");
  parts.push("read the first 200 lines, last 100 lines, and all exported/public interfaces.");
  parts.push("");
  parts.push("If skeleton data was provided, you do NOT need to extract imports, exports,");
  parts.push("or function signatures manually — use the skeleton data. Focus your reading");
  parts.push("on UNDERSTANDING the code: patterns, issues, quality, purpose, and semantic");
  parts.push("concerns that require judgment.");
  parts.push("");
  parts.push("For each file produce analysis according to the guide criteria.");
  parts.push("");

  // Confidence scoring rules
  parts.push("### Confidence Scoring Rules");
  parts.push("");
  parts.push("Every issue MUST include a `confidence` and `source` field.");
  parts.push("");
  parts.push("| Source | Default Confidence | Description |");
  parts.push("|--------|-------------------|-------------|");
  parts.push("| `linter` | `definite` | From deterministic linter output. These are facts. |");
  parts.push("| `typecheck` | `definite` | From compiler/type checker. Authoritative. |");
  parts.push("| `prescan` | `high` | From grep-based pattern detection. Pattern matched but context might make it valid. |");
  parts.push("| `llm-analysis` | `medium` | From your code reading with clear evidence (specific code cited). |");
  parts.push("| `cross-module` | `low` | From cross-module analysis or architectural opinions. Subjective. |");
  parts.push("");
  parts.push("You may upgrade confidence from the default when evidence is strong");
  parts.push("(e.g., SQL injection with visible string concatenation can be `high`).");
  parts.push("Do NOT downgrade `definite` findings from tools.");
  parts.push("");

  // Category-specific instructions
  if (params.category === "config" || params.category === "ci_cd") {
    parts.push("### Category-Specific: Configuration/CI");
    parts.push("Focus on: correctness and completeness of configuration, security issues");
    parts.push("(exposed secrets, permissive settings), consistency with the actual codebase,");
    parts.push("and missing recommended configurations.");
    parts.push("");
  } else if (params.category === "docs") {
    parts.push("### Category-Specific: Documentation");
    parts.push("Focus on: which docs exist vs what's missing (README, CONTRIBUTING, CHANGELOG,");
    parts.push("API docs, architecture docs), staleness (do docs reference things that no longer");
    parts.push("exist?), completeness (are all public APIs documented?), accuracy (do examples");
    parts.push("match current code patterns?).");
    parts.push("");
  }

  // Output format
  const moduleId = params.directories[0]
    .replace(/\/$/, "")
    .replace(/\//g, "_");
  parts.push(`Output structured JSON to ${params.outputPath}:`);
  parts.push("");
  parts.push("```json");
  parts.push("{");
  parts.push(`  "directory": "${params.directories[0]}",`);
  parts.push(`  "directories_analyzed": ${JSON.stringify(params.directories)},`);
  parts.push(`  "category": "${params.category}",`);
  parts.push(`  "languages_found": ${JSON.stringify(params.languages)},`);
  parts.push('  "purpose": "one-line description of what this module/area does",');
  parts.push('  "file_count": 0,');
  parts.push('  "total_lines": 0,');
  parts.push('  "files": [');
  parts.push('    {');
  parts.push('      "path": "file.ts",');
  parts.push('      "language": "typescript",');
  parts.push('      "lines": 0,');
  parts.push('      "purpose": "what this file does",');
  parts.push('      "exports": [],');
  parts.push('      "imports_from": { "internal": [], "external": [] },');
  parts.push('      "patterns": {');
  parts.push('        "error_handling": "description",');
  parts.push('        "async_style": "async/await | promises | callbacks | mixed",');
  parts.push('        "naming_convention": "camelCase | snake_case | PascalCase | mixed",');
  parts.push('        "type_safety": "strict | loose | none",');
  parts.push('        "has_tests": false,');
  parts.push('        "documentation": "well-documented | sparse | none"');
  parts.push('      },');
  parts.push('      "functions": [],');
  parts.push('      "issues": []');
  parts.push('    }');
  parts.push('  ],');
  parts.push('  "internal_dependencies": [],');
  parts.push('  "external_dependencies": [],');
  parts.push('  "module_level_issues": [],');
  parts.push('  "test_coverage": "full | partial | none | not-applicable",');
  parts.push('  "documentation_quality": "comprehensive | adequate | sparse | missing",');
  // Specialist triage
  parts.push('  "specialist_triage": {');
  parts.push('    "error_handling": { "files_flagged": ["path:line"], "reason": "brief description" },');
  parts.push('    "security": { "files_flagged": ["path:line"], "reason": "brief description" },');
  parts.push('    "type_design": { "files_flagged": ["path:line"], "reason": "brief description" },');
  parts.push('    "test_quality": { "files_flagged": ["path:line"], "reason": "brief description" },');
  parts.push('    "performance": { "files_flagged": ["path:line"], "reason": "brief description" },');
  parts.push('    "complexity": { "files_flagged": ["path:line"], "reason": "brief description" }');
  parts.push('  }');
  parts.push("}");
  parts.push("```");
  parts.push("");
  parts.push("In the `specialist_triage` field, ONLY include domains where files actually");
  parts.push("warrant specialist review. Omit domains with no concerns (don't include");
  parts.push("empty objects). Each domain's `files_flagged` should list specific file paths");
  parts.push("with line numbers where the concern exists.");

  return parts.join("\n");
}

// ----- Context assembly helpers -----

async function readGuideFiles(guideFiles: string[]): Promise<string> {
  const contents: string[] = [];
  for (const guide of guideFiles) {
    try {
      const content = await readFile(guide, "utf-8");
      contents.push(`--- ${guide.split("/").pop()} ---`);
      contents.push(content);
    } catch {
      // Guide file not found — skip
    }
  }
  return contents.join("\n\n");
}

async function readSkeletonData(
  auditDir: string,
  languages: string[],
  directories: string[],
): Promise<string> {
  const skeletonDir = join(auditDir, "data", "skeletons");
  const parts: string[] = [];

  // Map languages to skeleton files
  const langToFile: Record<string, string> = {
    typescript: "typescript.json",
    javascript: "typescript.json",
    python: "python.json",
    go: "go.json",
    rust: "rust.json",
    java: "java.json",
  };

  const processedFiles = new Set<string>();

  for (const lang of languages) {
    const skelFile = langToFile[lang];
    if (!skelFile || processedFiles.has(skelFile)) continue;
    processedFiles.add(skelFile);

    try {
      const data = await readFile(join(skeletonDir, skelFile), "utf-8");
      const parsed = JSON.parse(data);

      if (typeof parsed === "object" && parsed !== null) {
        // Filter skeleton entries to only those in our directories
        const filtered: Record<string, unknown> = {};
        for (const [filePath, entry] of Object.entries(parsed)) {
          for (const dir of directories) {
            const dirNormalized = dir.replace(/\/$/, "");
            if (
              filePath.startsWith(dirNormalized + "/") ||
              filePath.startsWith("./" + dirNormalized + "/") ||
              dirNormalized === "_root_"
            ) {
              filtered[filePath] = entry;
              break;
            }
          }
        }

        if (Object.keys(filtered).length > 0) {
          parts.push(`[${skelFile}]`);
          parts.push(JSON.stringify(filtered, null, 2));
        }
      }
    } catch {
      // Skeleton file not found or invalid
    }
  }

  return parts.join("\n\n");
}

async function readPrescanForDirs(
  auditDir: string,
  directories: string[],
): Promise<string> {
  // The prescan summary is project-wide. For now, include it as-is
  // since we can't easily filter line-by-line by directory.
  // Future improvement: store prescan results as JSON for per-file filtering.
  try {
    const summary = await readFile(
      join(auditDir, "prescan", "prescan-summary.txt"),
      "utf-8",
    );
    return summary;
  } catch {
    return "";
  }
}

async function readLinterResultsForDirs(
  auditDir: string,
  directories: string[],
): Promise<string> {
  const linterDir = join(auditDir, "tool-output", "linter-results");
  const parts: string[] = [];

  try {
    const files = await readdir(linterDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await readFile(join(linterDir, file), "utf-8");
        const parsed = JSON.parse(data);

        // Filter to relevant directories
        if (Array.isArray(parsed)) {
          // ESLint format: [{filePath, messages}]
          const filtered = parsed.filter((entry: any) => {
            if (!entry.filePath) return false;
            return directories.some((dir) => {
              const dirNormalized = dir.replace(/\/$/, "");
              return (
                entry.filePath.includes(dirNormalized + "/") ||
                entry.filePath.includes("/" + dirNormalized + "/")
              );
            });
          });
          if (filtered.length > 0) {
            parts.push(`[${file}]`);
            parts.push(JSON.stringify(filtered, null, 2));
          }
        }
      } catch {
        // Invalid JSON — skip
      }
    }
  } catch {
    // No linter results
  }

  return parts.join("\n\n");
}

async function readTypecheckForDirs(
  auditDir: string,
  directories: string[],
): Promise<string> {
  const typecheckDir = join(auditDir, "tool-output", "typecheck");
  const parts: string[] = [];

  try {
    const files = await readdir(typecheckDir);
    for (const file of files) {
      try {
        const data = await readFile(join(typecheckDir, file), "utf-8");
        // Filter lines that reference our directories
        const lines = data.split("\n").filter((line) => {
          return directories.some((dir) => {
            const dirNormalized = dir.replace(/\/$/, "");
            return line.includes(dirNormalized + "/") || line.includes("/" + dirNormalized + "/");
          });
        });
        if (lines.length > 0) {
          parts.push(`[${file}]`);
          parts.push(lines.join("\n"));
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // No typecheck results
  }

  return parts.join("\n\n");
}

async function readSourceFiles(
  projectRoot: string,
  directories: string[],
  tokenBudget: number,
  currentTokens: number,
): Promise<{ content: string; filesIncluded: number; filesSkeletonOnly: number }> {
  let tokensUsed = currentTokens;
  let filesIncluded = 0;
  let filesSkeletonOnly = 0;
  const parts: string[] = [];

  for (const dir of directories) {
    const dirNormalized = dir.replace(/\/$/, "");
    const dirPath =
      dirNormalized === "_root_"
        ? projectRoot
        : join(projectRoot, dirNormalized);

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const filePath = join(dirPath, entry.name);
        const relPath =
          dirNormalized === "_root_"
            ? entry.name
            : join(dirNormalized, entry.name);

        try {
          const fileStat = await stat(filePath);
          const estimatedFileTokens = Math.ceil(fileStat.size / 4);

          if (fitsInBudget(tokensUsed, estimatedFileTokens, tokenBudget)) {
            const content = await readFile(filePath, "utf-8");

            // Truncate very large files
            let fileContent: string;
            const lines = content.split("\n");
            if (lines.length > 1000) {
              const head = lines.slice(0, 200).join("\n");
              const tail = lines.slice(-100).join("\n");
              fileContent = `${head}\n\n... [${lines.length - 300} lines truncated] ...\n\n${tail}`;
            } else {
              fileContent = content;
            }

            parts.push(`--- ${relPath} ---`);
            parts.push(fileContent);
            parts.push("");
            tokensUsed += estimateTokens(fileContent);
            filesIncluded++;
          } else {
            parts.push(`--- ${relPath} [skeleton only — budget exceeded] ---`);
            filesSkeletonOnly++;
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist or unreadable
    }
  }

  return { content: parts.join("\n"), filesIncluded, filesSkeletonOnly };
}

// ----- Main tool function -----

export async function getModuleContext(
  input: GetModuleContextInput,
  pluginRoot: string,
): Promise<GetModuleContextResult> {
  const state = getState();
  if (!state) {
    throw new Error("State not initialized. Call audit_discover first.");
  }

  const assignment = state.moduleAssignments.find(
    (a) => a.id === input.assignmentId,
  );
  if (!assignment) {
    throw new Error(
      `Assignment "${input.assignmentId}" not found. Available: ${state.moduleAssignments.map((a) => a.id).join(", ")}`,
    );
  }

  const tokenBudget = input.tokenBudget ?? 80_000;
  const auditDir = state.auditDir;
  const projectRoot = state.projectRoot;

  // Determine output path
  const moduleId = assignment.directories[0]
    .replace(/\/$/, "")
    .replace(/\//g, "_");
  const outputFilename = (moduleId === "_root_" ? "root_config" : moduleId) + ".json";
  const outputPath = join(auditDir, "modules", outputFilename);

  // Assemble context pieces with token tracking
  let tokensUsed = 0;

  // Priority 1: Language guides (always included)
  const guideContent = await readGuideFiles(assignment.guideFiles);
  const guideTokens = estimateTokens(guideContent);
  tokensUsed += guideTokens;

  // Priority 2: Skeleton data (always included)
  const skeletonContent = await readSkeletonData(
    auditDir,
    assignment.languages,
    assignment.directories,
  );
  const skeletonTokens = estimateTokens(skeletonContent);
  tokensUsed += skeletonTokens;

  // Priority 3: Linter/prescan results (always included)
  const prescanContent = await readPrescanForDirs(auditDir, assignment.directories);
  tokensUsed += estimateTokens(prescanContent);

  const linterContent = await readLinterResultsForDirs(
    auditDir,
    assignment.directories,
  );
  tokensUsed += estimateTokens(linterContent);

  const typecheckContent = await readTypecheckForDirs(
    auditDir,
    assignment.directories,
  );
  tokensUsed += estimateTokens(typecheckContent);

  // Priority 4: Source files (budget-limited)
  const { content: sourceFiles, filesIncluded, filesSkeletonOnly } =
    await readSourceFiles(projectRoot, assignment.directories, tokenBudget, tokensUsed);
  tokensUsed += estimateTokens(sourceFiles);

  // Build the complete prompt
  const taskPrompt = buildTaskPrompt({
    directories: assignment.directories,
    category: assignment.category,
    languages: assignment.languages,
    guideContent,
    skeletonContent,
    prescanContent,
    linterContent,
    typecheckContent,
    sourceFiles,
    outputPath,
    pluginRoot,
  });

  const totalTokens = estimateTokens(taskPrompt);

  const validationCommand = "Call the audit_validate_modules MCP tool to validate your output.";

  return {
    assignmentId: input.assignmentId,
    taskPrompt,
    tokenEstimate: totalTokens,
    filesIncluded,
    filesSkeletonOnly,
    outputPath,
    validationCommand,
  };
}

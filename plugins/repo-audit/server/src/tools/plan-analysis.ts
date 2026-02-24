import { readFile, writeFile, mkdir, access, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getState, updateState, persistState, addError, type ModuleAssignment } from "../lib/state.js";
import { readDetectionJson, type DetectionResult } from "../lib/detection.js";
import { estimateTokensForFile, estimateTokens } from "../lib/tokens.js";

// ----- Interfaces -----

interface PlanAnalysisInput {
  maxAgents?: number;
  tokenBudget?: number;
  incrementalModules?: string[];
}

interface AssignmentOutput {
  id: string;
  directories: string[];
  category: string;
  languages: string[];
  guideFiles: string[];
  fileCount: number;
  estimatedTokens: number;
  hasPrescanHits: boolean;
  hasLinterIssues: boolean;
  existingAnalysis: boolean;
}

interface PlanAnalysisResult {
  assignments: AssignmentOutput[];
  totalAssignments: number;
  skippedDirectories: string[];
  reusedModules: string[];
}

// ----- Helpers -----

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a directory key (e.g. "src/auth/") to a module filename
 * (e.g. "src_auth.json")
 */
function dirKeyToModuleFilename(dirKey: string): string {
  let name = dirKey.replace(/\/$/, "");
  if (name === "_root_") name = "root_config";
  return name.replace(/\//g, "_") + ".json";
}

/**
 * Get the primary language group key for batching.
 * Directories sharing the same language group can be batched together.
 */
function getLanguageGroupKey(languages: string[]): string {
  const codeLangs = languages.filter(
    (l) => !["config", "docs", "shell", "sql"].includes(l),
  );
  if (codeLangs.length === 0) {
    // Pure config/docs/shell — group by first language
    return languages[0] ?? "general";
  }
  return codeLangs.sort().join("+");
}

async function getPrescanHits(
  auditDir: string,
  directories: string[],
): Promise<boolean> {
  try {
    const summaryPath = join(auditDir, "prescan", "prescan-summary.txt");
    const data = await readFile(summaryPath, "utf-8");
    // Simple check: if there are any non-zero matches, prescan has hits
    // A more precise check would filter by directory, but for planning
    // purposes a boolean is sufficient
    const totalMatch = data.match(/Total matches:\s*(\d+)/);
    return totalMatch ? parseInt(totalMatch[1], 10) > 0 : false;
  } catch {
    return false;
  }
}

async function hasLinterResults(
  auditDir: string,
): Promise<boolean> {
  try {
    const linterDir = join(auditDir, "tool-output", "linter-results");
    const files = await readdir(linterDir);
    return files.length > 0;
  } catch {
    return false;
  }
}

async function estimateDirectoryTokens(
  projectRoot: string,
  dirKey: string,
  fileCount: number,
  guideFiles: string[],
): Promise<number> {
  let tokens = 0;

  // Estimate source file tokens based on average file size
  // Rough heuristic: average code file is ~100 lines, ~30 chars/line = 3000 chars = ~750 tokens
  tokens += fileCount * 750;

  // Add language guide tokens
  for (const guide of guideFiles) {
    try {
      const s = await stat(guide);
      tokens += estimateTokensForFile(s.size);
    } catch {
      tokens += 500; // Default estimate for a missing guide
    }
  }

  // Add base template overhead (~2000 tokens for template + instructions)
  tokens += 2000;

  return tokens;
}

// ----- Core planning logic -----

interface DirEntry {
  key: string;
  category: string;
  fileCount: number;
  languages: string[];
  guideFiles: string[];
  languageGroup: string;
}

function planAssignments(
  dirs: DirEntry[],
  maxAgents: number,
): { batches: DirEntry[][]; dedicated: DirEntry[] } {
  const dedicated: DirEntry[] = [];
  const smallDirs: DirEntry[] = [];
  const mediumDirs: DirEntry[] = [];
  const largeDirs: DirEntry[] = [];

  for (const dir of dirs) {
    // Root config and CI/CD always get dedicated agents
    if (dir.key === "_root_" || dir.category === "ci_cd") {
      dedicated.push(dir);
      continue;
    }

    if (dir.fileCount < 5) {
      smallDirs.push(dir);
    } else if (dir.fileCount <= 20) {
      mediumDirs.push(dir);
    } else {
      // Large dirs: for now treat as dedicated (splitting into sub-dirs
      // would require re-scanning, which discover already did)
      largeDirs.push(dir);
    }
  }

  // Medium dirs: one per agent
  // Large dirs: one per agent (could split later if needed)
  const soloAgents = [...mediumDirs.map((d) => [d]), ...largeDirs.map((d) => [d])];

  // Small dirs: batch by language group, 3-5 per batch
  const languageGroups = new Map<string, DirEntry[]>();
  for (const dir of smallDirs) {
    const group = dir.languageGroup;
    if (!languageGroups.has(group)) languageGroups.set(group, []);
    languageGroups.get(group)!.push(dir);
  }

  const batches: DirEntry[][] = [];
  for (const [, group] of languageGroups) {
    // Batch in groups of 3-5
    for (let i = 0; i < group.length; i += 4) {
      const batch = group.slice(i, Math.min(i + 5, group.length));
      batches.push(batch);
    }
  }

  // Combine all assignments
  const allBatches = [
    ...dedicated.map((d) => [d]),
    ...soloAgents,
    ...batches,
  ];

  // If we exceed maxAgents, merge the smallest batches
  while (allBatches.length > maxAgents && allBatches.length > 1) {
    // Sort by total file count (ascending)
    allBatches.sort(
      (a, b) =>
        a.reduce((sum, d) => sum + d.fileCount, 0) -
        b.reduce((sum, d) => sum + d.fileCount, 0),
    );

    // Merge the two smallest
    const smallest = allBatches.shift()!;
    const secondSmallest = allBatches.shift()!;
    allBatches.push([...smallest, ...secondSmallest]);
  }

  return { batches: allBatches, dedicated: [] };
}

// ----- Main tool function -----

export async function planAnalysis(
  input: PlanAnalysisInput,
  pluginRoot: string,
): Promise<PlanAnalysisResult> {
  const state = getState();
  if (!state) {
    throw new Error("State not initialized. Call audit_discover first.");
  }

  const auditDir = state.auditDir;
  const projectRoot = state.projectRoot;

  updateState({ phase: "analyzing" });

  // Read detection.json
  const detection = await readDetectionJson(auditDir);
  if (!detection) {
    throw new Error("detection.json not found. Run audit_discover first.");
  }

  const maxAgents = input.maxAgents ?? (detection.monorepo ? 30 : 20);
  const tokenBudget = input.tokenBudget ?? 80_000;
  const incrementalModules = input.incrementalModules ?? null;

  // Separate directories into analyzable and skipped
  const analyzableDirs: DirEntry[] = [];
  const skippedDirectories: string[] = [];
  const reusedModules: string[] = [];

  for (const [key, info] of Object.entries(detection.all_directories)) {
    if (info.category === "generated" || info.category === "vendored") {
      skippedDirectories.push(key);
      continue;
    }

    // In incremental mode, check if this module should be reanalyzed
    if (incrementalModules) {
      const moduleFile = dirKeyToModuleFilename(key);
      const modulePath = join(auditDir, "modules", moduleFile);
      if (!incrementalModules.includes(key) && await fileExists(modulePath)) {
        reusedModules.push(key);
        continue;
      }
    }

    analyzableDirs.push({
      key,
      category: info.category,
      fileCount: info.est_files,
      languages: info.languages,
      guideFiles: info.guide_files,
      languageGroup: getLanguageGroupKey(info.languages),
    });
  }

  // Plan assignments
  const { batches } = planAssignments(analyzableDirs, maxAgents);

  // Check for prescan/linter data availability
  const hasPrescan = await getPrescanHits(auditDir, []);
  const hasLinters = await hasLinterResults(auditDir);

  // Build assignment outputs
  const assignments: AssignmentOutput[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const id = `module-${String(i + 1).padStart(2, "0")}`;

    // Aggregate info across batch
    const directories = batch.map((d) => d.key);
    const allLanguages = [...new Set(batch.flatMap((d) => d.languages))];
    const allGuides = [...new Set(batch.flatMap((d) => d.guideFiles))];
    const totalFiles = batch.reduce((sum, d) => sum + d.fileCount, 0);
    const primaryCategory =
      batch.length === 1 ? batch[0].category : "source";

    // Estimate tokens
    const estimatedTokens = await estimateDirectoryTokens(
      projectRoot,
      directories[0],
      totalFiles,
      allGuides,
    );

    // Check for existing analysis
    const firstModuleFile = dirKeyToModuleFilename(batch[0].key);
    const existingAnalysis = await fileExists(
      join(auditDir, "modules", firstModuleFile),
    );

    assignments.push({
      id,
      directories,
      category: primaryCategory,
      languages: allLanguages,
      guideFiles: allGuides,
      fileCount: totalFiles,
      estimatedTokens: Math.min(estimatedTokens, tokenBudget),
      hasPrescanHits: hasPrescan,
      hasLinterIssues: hasLinters,
      existingAnalysis,
    });
  }

  // Update state
  const moduleAssignments: ModuleAssignment[] = assignments.map((a) => ({
    ...a,
  }));
  updateState({ moduleAssignments });

  // Write assignment plan
  const planPath = join(auditDir, "data", "assignment-plan.json");
  await mkdir(join(auditDir, "data"), { recursive: true });
  await writeFile(
    planPath,
    JSON.stringify(
      { assignments, skippedDirectories, reusedModules },
      null,
      2,
    ),
  );

  // Verify completeness
  const assignedDirs = new Set(assignments.flatMap((a) => a.directories));
  const allDirs = new Set(Object.keys(detection.all_directories));
  const missing: string[] = [];
  for (const dir of allDirs) {
    const info = detection.all_directories[dir];
    if (info.category === "generated" || info.category === "vendored") continue;
    if (incrementalModules && reusedModules.includes(dir)) continue;
    if (!assignedDirs.has(dir)) missing.push(dir);
  }

  if (missing.length > 0) {
    addError(
      "audit_plan_analysis",
      `Directories not assigned to any agent: ${missing.join(", ")}`,
    );
    // Auto-fix: add missing dirs to the last assignment or create a new one
    if (assignments.length > 0 && assignments.length < maxAgents) {
      const lastId = `module-${String(assignments.length + 1).padStart(2, "0")}`;
      const missingInfo = missing.map((k) => detection.all_directories[k]);
      assignments.push({
        id: lastId,
        directories: missing,
        category: "source",
        languages: [...new Set(missingInfo.flatMap((d) => d.languages))],
        guideFiles: [...new Set(missingInfo.flatMap((d) => d.guide_files))],
        fileCount: missingInfo.reduce((sum, d) => sum + d.est_files, 0),
        estimatedTokens: 5000,
        hasPrescanHits: hasPrescan,
        hasLinterIssues: hasLinters,
        existingAnalysis: false,
      });
    }
  }

  await persistState();

  return {
    assignments,
    totalAssignments: assignments.length,
    skippedDirectories,
    reusedModules,
  };
}

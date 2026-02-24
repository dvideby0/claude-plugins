/**
 * Merge sub-command findings into standard module JSONs.
 *
 * Migrated from scripts/merge-module-findings.sh.
 *
 * Takes findings (from sub-commands like audit-security) and merges them
 * into the sdlc-audit/modules/ schema. Creates new module JSONs for
 * modules that don't exist yet, or merges into existing ones.
 * Deduplicates by description + line_range.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FindingsFile,
  Finding,
  ModuleJson,
  ModuleIssue,
  ModuleFileEntry,
} from "../lib/types.js";

/**
 * Find the best matching directory from detection.json for a file path.
 * Uses longest prefix match — directories are sorted longest-first.
 */
function findModuleDir(
  filePath: string,
  directories: string[],
): string | null {
  // Sort by length descending for longest-prefix-first matching
  const sorted = [...directories].sort((a, b) => b.length - a.length);

  for (const dir of sorted) {
    const normDir = dir.replace(/\/$/, "");
    if (filePath === normDir || filePath.startsWith(normDir + "/")) {
      return normDir;
    }
  }

  return null;
}

/**
 * Derive a module directory name from a file path when no detection.json match.
 * Uses the first two path components, or the directory portion.
 */
function deriveModuleDir(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length > 2) return parts.slice(0, 2).join("/");
  if (parts.length === 2) return parts[0];
  return "_root_";
}

/**
 * Convert a finding into a ModuleIssue, including only non-null fields.
 * Finding fields are cast to ModuleIssue enums at this boundary since
 * findings originate from our own sub-commands.
 */
function findingToIssue(f: Finding): ModuleIssue {
  const issue: ModuleIssue = {
    severity: f.severity as ModuleIssue["severity"],
    description: f.description,
  };
  if (f.confidence) issue.confidence = f.confidence as ModuleIssue["confidence"];
  if (f.category) issue.category = f.category;
  if (f.source) issue.source = f.source as ModuleIssue["source"];
  if (f.line_range !== undefined && f.line_range !== null) issue.line_range = f.line_range;
  if (f.impact) issue.impact = f.impact;
  if (f.remediation) issue.remediation = f.remediation;
  if (f.owasp) issue.owasp = f.owasp;
  if (f.guide_rule) issue.guide_rule = f.guide_rule;
  return issue;
}

/**
 * Check if an issue is a duplicate of an existing one.
 * Matches on description + line_range (including null/undefined).
 */
function isDuplicate(
  existing: ModuleIssue[],
  newIssue: ModuleIssue,
): boolean {
  return existing.some(
    (e) =>
      e.description === newIssue.description &&
      JSON.stringify(e.line_range ?? null) ===
        JSON.stringify(newIssue.line_range ?? null),
  );
}

export interface MergeResult {
  created: number;
  updated: number;
  total: number;
}

export interface MergeModuleFindingsOptions {
  projectRoot: string;
  findingsFile: string;
  sourceCommand: string;
}

/**
 * Merge findings from a findings file into module JSONs.
 *
 * @returns Counts of created/updated modules
 */
export async function mergeModuleFindings(
  options: MergeModuleFindingsOptions,
): Promise<MergeResult> {
  const { projectRoot, findingsFile, sourceCommand } = options;
  const modulesDir = join(projectRoot, "sdlc-audit", "modules");
  const detectionFile = join(
    projectRoot,
    "sdlc-audit",
    "data",
    "detection.json",
  );

  // Read findings
  const findingsRaw = await readFile(findingsFile, "utf-8");
  const findingsData = JSON.parse(findingsRaw) as FindingsFile;

  if (!findingsData.findings || findingsData.findings.length === 0) {
    return { created: 0, updated: 0, total: 0 };
  }

  await mkdir(modulesDir, { recursive: true });

  // Read detection.json directory mapping
  let allDirectories: Record<
    string,
    { category?: string; languages?: string[] }
  > = {};
  try {
    const detRaw = await readFile(detectionFile, "utf-8");
    const detData = JSON.parse(detRaw);
    allDirectories = detData.all_directories ?? {};
  } catch {
    // No detection.json — will derive modules from paths
  }

  const dirKeys = Object.keys(allDirectories);

  // Group findings by module directory
  const grouped = new Map<string, Finding[]>();
  for (const finding of findingsData.findings) {
    const matchedDir = findModuleDir(finding.file, dirKeys);
    const moduleDir = matchedDir ?? deriveModuleDir(finding.file);

    const group = grouped.get(moduleDir);
    if (group) {
      group.push(finding);
    } else {
      grouped.set(moduleDir, [finding]);
    }
  }

  // Process each module group
  let created = 0;
  let updated = 0;

  for (const [moduleDir, findings] of grouped) {
    const moduleName = moduleDir.replace(/\//g, "_");
    const moduleFile = join(modulesDir, `${moduleName}.json`);

    // Try to read existing module
    let existing: ModuleJson | null = null;
    try {
      const raw = await readFile(moduleFile, "utf-8");
      existing = JSON.parse(raw) as ModuleJson;
    } catch {
      // Module doesn't exist yet
    }

    if (existing) {
      // Merge into existing module
      mergeIntoExisting(existing, findings, sourceCommand);
      await writeFile(moduleFile, JSON.stringify(existing, null, 2));
      updated++;
    } else {
      // Create new skeleton module
      const newModule = createNewModule(
        moduleDir,
        findings,
        sourceCommand,
        allDirectories,
      );
      await writeFile(moduleFile, JSON.stringify(newModule, null, 2));
      created++;
    }
  }

  return { created, updated, total: created + updated };
}

/**
 * Merge findings into an existing module JSON (mutates in place).
 */
function mergeIntoExisting(
  module: ModuleJson,
  findings: Finding[],
  sourceCommand: string,
): void {
  // Update sources (deduplicate)
  if (!module.sources) module.sources = [];
  if (!module.sources.includes(sourceCommand)) {
    module.sources.push(sourceCommand);
  }

  // Build existing issues map by file path
  const issuesByFile = new Map<string, ModuleIssue[]>();
  for (const file of module.files ?? []) {
    issuesByFile.set(file.path, [...(file.issues ?? [])]);
  }

  // Merge new findings
  for (const finding of findings) {
    const issue = findingToIssue(finding);
    const existingIssues = issuesByFile.get(finding.file) ?? [];

    if (!isDuplicate(existingIssues, issue)) {
      existingIssues.push(issue);
      issuesByFile.set(finding.file, existingIssues);
    }
  }

  // Collect all unique file paths (existing + new)
  const allPaths = new Set<string>();
  for (const file of module.files ?? []) {
    allPaths.add(file.path);
  }
  for (const finding of findings) {
    allPaths.add(finding.file);
  }

  // Build existing file entries map for preserving metadata
  const existingFileMap = new Map<string, ModuleFileEntry>();
  for (const file of module.files ?? []) {
    existingFileMap.set(file.path, { ...file });
  }

  // Rebuild files array
  const newFiles: ModuleFileEntry[] = [];
  for (const path of allPaths) {
    const existingEntry = existingFileMap.get(path);
    if (existingEntry) {
      // Update existing entry with merged issues
      existingEntry.issues = issuesByFile.get(path) ?? [];
      newFiles.push(existingEntry);
    } else {
      // New file entry
      newFiles.push({
        path,
        issues: issuesByFile.get(path) ?? [],
      });
    }
  }

  module.files = newFiles;
}

/**
 * Create a new skeleton module JSON from findings.
 */
function createNewModule(
  moduleDir: string,
  findings: Finding[],
  sourceCommand: string,
  allDirectories: Record<string, { category?: string; languages?: string[] }>,
): ModuleJson {
  // Get category and languages from detection.json
  const dirInfo =
    allDirectories[moduleDir] ?? allDirectories[moduleDir + "/"] ?? {};
  const category = dirInfo.category ?? "source";
  const languages = dirInfo.languages ?? [];

  // Group findings by file path
  const issuesByFile = new Map<string, ModuleIssue[]>();
  for (const finding of findings) {
    const issue = findingToIssue(finding);
    const existing = issuesByFile.get(finding.file) ?? [];
    existing.push(issue);
    issuesByFile.set(finding.file, existing);
  }

  // Build file entries
  const files: ModuleFileEntry[] = [...issuesByFile.entries()].map(([path, issues]) => ({
    path,
    issues,
  }));

  return {
    directory: moduleDir,
    directories_analyzed: [moduleDir],
    category,
    languages_found: languages,
    purpose: `Auto-created by ${sourceCommand} — run full /audit for complete analysis`,
    file_count: files.length,
    total_lines: 0,
    files,
    internal_dependencies: [],
    external_dependencies: [],
    test_coverage: "unknown",
    documentation_quality: "unknown",
    sources: [sourceCommand],
  };
}

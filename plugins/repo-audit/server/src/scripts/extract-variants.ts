/**
 * Extract variant analysis candidates from module JSONs.
 *
 * Migrated from scripts/extract-variants.sh.
 *
 * Reads all module analysis results, extracts critical/warning issues,
 * groups them by guide_rule to identify recurring patterns, and flags
 * systemic patterns (same issue across 3+ directories).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { readAllModules } from "../lib/modules.js";
import type {
  VariantCandidates,
  SystemicPattern,
  SingleCritical,
} from "../lib/types.js";

interface FlatIssue {
  category: string;
  description: string;
  file: string;
  line_range?: string | [number, number];
  guide_rule: string;
  severity: string;
}

/**
 * Extract the directory from a file path (everything before the last slash).
 */
function fileDirectory(filePath: string): string {
  const dir = dirname(filePath);
  return dir === "." ? "" : dir;
}

/**
 * Extract variant candidates from module JSONs.
 *
 * @param projectRoot Path to the project root
 * @returns The variant candidates data, also written to disk
 */
export async function extractVariants(
  projectRoot: string,
): Promise<VariantCandidates> {
  const modulesDir = join(projectRoot, "sdlc-audit", "modules");
  const outputDir = join(projectRoot, "sdlc-audit", "data");
  const outputFile = join(outputDir, "variant-candidates.json");

  const loaded = await readAllModules(modulesDir);

  if (loaded.length === 0) {
    const empty: VariantCandidates = {
      systemic_patterns: {},
      single_critical: {},
      category_distribution: {},
      total_high_severity: 0,
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputFile, JSON.stringify(empty, null, 2));
    return empty;
  }

  // Flatten all critical/warning issues from all modules
  const flatIssues: FlatIssue[] = [];
  for (const mod of loaded) {
    for (const file of mod.data.files ?? []) {
      for (const issue of file.issues ?? []) {
        if (issue.severity !== "critical" && issue.severity !== "warning") {
          continue;
        }
        flatIssues.push({
          category: issue.category ?? "",
          description: issue.description ?? "",
          file: file.path ?? "",
          line_range: issue.line_range,
          guide_rule: issue.guide_rule ?? "",
          severity: issue.severity,
        });
      }
    }
  }

  // Category distribution
  const categoryDistribution: Record<string, number> = {};
  for (const issue of flatIssues) {
    const cat = issue.category || "unknown";
    categoryDistribution[cat] = (categoryDistribution[cat] ?? 0) + 1;
  }

  // Group by guide_rule (only issues that have one)
  const ruleGroups = new Map<string, FlatIssue[]>();
  for (const issue of flatIssues) {
    if (!issue.guide_rule) continue;
    const group = ruleGroups.get(issue.guide_rule);
    if (group) {
      group.push(issue);
    } else {
      ruleGroups.set(issue.guide_rule, [issue]);
    }
  }

  // Systemic patterns: same rule in 3+ different directories
  const systemicPatterns: Record<string, SystemicPattern> = {};
  for (const [rule, issues] of ruleGroups) {
    const directories = [...new Set(issues.map((i) => fileDirectory(i.file)))];
    if (directories.length >= 3) {
      systemicPatterns[rule] = {
        count: issues.length,
        files: issues.map((i) => i.file),
        directories,
        severity: issues[0].severity,
        category: issues[0].category,
      };
    }
  }

  // Single critical: appeared exactly once and is critical
  const singleCritical: Record<string, SingleCritical> = {};
  for (const [rule, issues] of ruleGroups) {
    if (issues.length === 1 && issues[0].severity === "critical") {
      singleCritical[rule] = {
        category: issues[0].category,
        description: issues[0].description,
        file: issues[0].file,
        line_range: issues[0].line_range,
        guide_rule: issues[0].guide_rule,
        severity: issues[0].severity,
      };
    }
  }

  const result: VariantCandidates = {
    systemic_patterns: systemicPatterns,
    single_critical: singleCritical,
    category_distribution: categoryDistribution,
    total_high_severity: flatIssues.length,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, JSON.stringify(result, null, 2));

  return result;
}

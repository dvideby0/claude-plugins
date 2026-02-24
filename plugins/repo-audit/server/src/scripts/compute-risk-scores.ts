/**
 * Compute per-module risk scores.
 *
 * Migrated from scripts/compute-risk-scores.sh.
 *
 * Formula: risk = (blast_radius * complexity) / safety_net
 *   blast_radius: max(fan_in, 1) from dependency graph
 *   complexity:   total_lines + weighted_issue_count + (high_complexity * 2)
 *   safety_net:   test_coverage_score + documentation_quality_score (floor 0.5)
 *
 * Issues are weighted by confidence:
 *   definite=1.0, high=0.8, medium=0.5, low=0.2, missing=0.5
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAllModules } from "../lib/modules.js";
import type {
  RiskScoresOutput,
  RiskScoreEntry,
  DependencyData,
} from "../lib/types.js";

const CONFIDENCE_WEIGHTS: Record<string, number> = {
  definite: 1.0,
  high: 0.8,
  medium: 0.5,
  low: 0.2,
};
const DEFAULT_CONFIDENCE_WEIGHT = 0.5;

const TEST_COVERAGE_SCORES: Record<string, number> = {
  full: 3,
  partial: 2,
  none: 0.5,
  "not-applicable": 1,
};
const DEFAULT_TEST_COVERAGE_SCORE = 0.5;

const DOC_QUALITY_SCORES: Record<string, number> = {
  comprehensive: 3,
  adequate: 2,
  sparse: 1,
  missing: 0.5,
};
const DEFAULT_DOC_QUALITY_SCORE = 0.5;

/** Round to 1 decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Load fan-in data from dependency-data.json if available.
 * Returns a map of module → fan_in. Falls back to empty map on any error.
 */
async function loadFanIns(
  depFilePath: string,
): Promise<Map<string, number>> {
  const fanIns = new Map<string, number>();
  try {
    const raw = await readFile(depFilePath, "utf-8");
    if (!raw.trim()) return fanIns;
    const depData = JSON.parse(raw) as DependencyData;
    const graph = depData.module_graph ?? {};
    for (const [mod, entry] of Object.entries(graph)) {
      fanIns.set(mod, entry.fan_in ?? 0);
    }
  } catch {
    // File missing, empty, or malformed — use defaults
  }
  return fanIns;
}

/**
 * Compute risk scores for all modules.
 *
 * @param projectRoot Path to the project root
 * @returns The risk scores output, also written to disk
 */
export async function computeRiskScores(
  projectRoot: string,
): Promise<RiskScoresOutput> {
  const modulesDir = join(projectRoot, "sdlc-audit", "modules");
  const depFilePath = join(projectRoot, "sdlc-audit", "data", "dependency-data.json");
  const outputDir = join(projectRoot, "sdlc-audit", "data");
  const outputFile = join(outputDir, "risk-scores.json");

  const loaded = await readAllModules(modulesDir);

  const emptyResult: RiskScoresOutput = {
    scores: [],
    top_10_highest_risk: [],
    risk_distribution: { critical: 0, high: 0, medium: 0, low: 0 },
  };

  if (loaded.length === 0) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputFile, JSON.stringify(emptyResult, null, 2));
    return emptyResult;
  }

  const fanIns = await loadFanIns(depFilePath);

  // Score each module
  const scores: RiskScoreEntry[] = [];

  for (const mod of loaded) {
    const moduleName = mod.data.directory ?? "unknown";
    const totalLines = mod.data.total_lines ?? 0;

    // Count issues and weighted issues
    let issueCount = 0;
    let weightedIssueCount = 0;
    let highComplexity = 0;

    for (const file of mod.data.files ?? []) {
      for (const issue of file.issues ?? []) {
        issueCount++;
        const weight =
          CONFIDENCE_WEIGHTS[issue.confidence ?? ""] ??
          DEFAULT_CONFIDENCE_WEIGHT;
        weightedIssueCount += weight;
      }
      for (const fn of file.functions ?? []) {
        if (fn.complexity === "high") {
          highComplexity++;
        }
      }
    }

    // Round weighted_issue_count to 1 decimal
    weightedIssueCount = round1(weightedIssueCount);

    const testCoverage = mod.data.test_coverage ?? "unknown";
    const docQuality = mod.data.documentation_quality ?? "unknown";
    const fanIn = fanIns.get(moduleName) ?? 0;

    const blastRadius = Math.max(fanIn, 1);
    const complexity = totalLines + weightedIssueCount + highComplexity * 2;
    const safetyNet =
      (TEST_COVERAGE_SCORES[testCoverage] ?? DEFAULT_TEST_COVERAGE_SCORE) +
      (DOC_QUALITY_SCORES[docQuality] ?? DEFAULT_DOC_QUALITY_SCORE);

    const riskScore = round1(
      (blastRadius * complexity) / Math.max(safetyNet, 0.5),
    );

    scores.push({
      module: moduleName,
      total_lines: totalLines,
      issue_count: issueCount,
      weighted_issue_count: weightedIssueCount,
      high_complexity: highComplexity,
      test_coverage: testCoverage,
      documentation_quality: docQuality,
      fan_in: fanIn,
      blast_radius: blastRadius,
      complexity,
      safety_net: safetyNet,
      risk_score: riskScore,
    });
  }

  // Sort descending by risk_score
  scores.sort((a, b) => b.risk_score - a.risk_score);

  // Percentile-based distribution
  const n = scores.length;
  const sortedVals = scores.map((s) => s.risk_score).sort((a, b) => a - b);

  let p90: number, p75: number, p50: number;
  if (n > 1) {
    p90 = sortedVals[Math.floor(n * 0.9)];
    p75 = sortedVals[Math.floor(n * 0.75)];
    p50 = sortedVals[Math.floor(n * 0.5)];
  } else {
    p90 = sortedVals[0] ?? 0;
    p75 = sortedVals[0] ?? 0;
    p50 = sortedVals[0] ?? 0;
  }

  const riskDistribution = {
    critical: scores.filter((s) => s.risk_score >= p90).length,
    high: scores.filter((s) => s.risk_score >= p75 && s.risk_score < p90).length,
    medium: scores.filter((s) => s.risk_score >= p50 && s.risk_score < p75).length,
    low: scores.filter((s) => s.risk_score < p50).length,
  };

  const result: RiskScoresOutput = {
    scores,
    top_10_highest_risk: scores.slice(0, 10).map((s) => s.module),
    risk_distribution: riskDistribution,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, JSON.stringify(result, null, 2));

  return result;
}

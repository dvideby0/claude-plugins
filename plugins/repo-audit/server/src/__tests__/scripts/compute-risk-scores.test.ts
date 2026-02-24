import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { computeRiskScores } from "../../scripts/compute-risk-scores.js";
import { buildDepGraph } from "../../scripts/build-dep-graph.js";
import {
  createTestProject,
  copyFixture,
  type TestProject,
} from "../helpers.js";
import type { RiskScoresOutput } from "../../lib/types.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

describe("computeRiskScores", () => {
  it("computes correct risk scores with dependency data", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    // Build dep graph first (provides fan-in data)
    await buildDepGraph(project.projectRoot);

    const result = await computeRiskScores(project.projectRoot);

    expect(result.scores).toHaveLength(3);

    // src_api: total_lines=1200, issues=3 (no confidence => 0.5 each)
    //   weighted_issue_count = 3 * 0.5 = 1.5
    //   high_complexity_functions = 2 (handle_request, parse_query)
    //   complexity = 1200 + 1.5 + (2*2) = 1205.5
    //   test_coverage = "none" -> 0.5, doc_quality = "missing" -> 0.5
    //   safety_net = 0.5 + 0.5 = 1.0
    //   fan_in for src_api = 0, blast_radius = max(0, 1) = 1
    //   risk = (1 * 1205.5) / 1.0 = 1205.5
    const apiScore = result.scores.find((s) => s.module === "src_api")!;
    expect(apiScore.risk_score).toBe(1205.5);
    expect(apiScore.weighted_issue_count).toBe(1.5);
    expect(apiScore.high_complexity).toBe(2);
    expect(apiScore.blast_radius).toBe(1);
    expect(apiScore.safety_net).toBe(1);

    // src_utils: total_lines=420, issues=1 (no confidence => 0.5)
    //   weighted_issue_count = 0.5
    //   high_complexity = 0
    //   complexity = 420 + 0.5 + 0 = 420.5
    //   test_coverage = "full" -> 3, doc_quality = "adequate" -> 2
    //   safety_net = 5.0
    //   fan_in = 2 (from dep graph), blast_radius = max(2, 1) = 2
    //   risk = (2 * 420.5) / 5.0 = 168.2
    const utilsScore = result.scores.find((s) => s.module === "src_utils")!;
    expect(utilsScore.risk_score).toBe(168.2);
    expect(utilsScore.fan_in).toBe(2);
    expect(utilsScore.blast_radius).toBe(2);
  });

  it("sorts scores in descending order", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    await buildDepGraph(project.projectRoot);
    const result = await computeRiskScores(project.projectRoot);

    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i - 1].risk_score).toBeGreaterThanOrEqual(
        result.scores[i].risk_score,
      );
    }
  });

  it("computes risk distribution that sums to total modules", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    await buildDepGraph(project.projectRoot);
    const result = await computeRiskScores(project.projectRoot);

    const dist = result.risk_distribution;
    expect(dist.critical + dist.high + dist.medium + dist.low).toBe(3);
  });

  it("defaults fan_in to 0 when no dependency data exists", async () => {
    project = await createTestProject();

    // No dep graph built — just copy modules
    await copyFixture("src_utils.json", project.modulesDir);

    const result = await computeRiskScores(project.projectRoot);

    expect(result.scores[0].fan_in).toBe(0);
    expect(result.scores[0].blast_radius).toBe(1); // max(0, 1)
    expect(result.scores[0].risk_score).toBeGreaterThan(0);
  });

  it("handles malformed dependency-data.json gracefully", async () => {
    project = await createTestProject();

    await copyFixture("src_utils.json", project.modulesDir);
    await writeFile(
      join(project.dataDir, "dependency-data.json"),
      "{not valid json",
    );

    const result = await computeRiskScores(project.projectRoot);

    expect(result.scores[0].fan_in).toBe(0);
    expect(result.scores[0].risk_score).toBeGreaterThan(0);
  });

  it("handles empty dependency-data.json gracefully", async () => {
    project = await createTestProject();

    await copyFixture("src_utils.json", project.modulesDir);
    await writeFile(join(project.dataDir, "dependency-data.json"), "");

    const result = await computeRiskScores(project.projectRoot);

    expect(result.scores[0].fan_in).toBe(0);
  });

  it("returns empty result for empty modules directory", async () => {
    project = await createTestProject();

    const result = await computeRiskScores(project.projectRoot);

    expect(result.scores).toHaveLength(0);
    expect(result.top_10_highest_risk).toHaveLength(0);
    expect(result.risk_distribution).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });

  it("handles modules with missing fields using defaults", async () => {
    project = await createTestProject();

    await copyFixture("src_missing_fields.json", project.modulesDir);

    const result = await computeRiskScores(project.projectRoot);

    const score = result.scores[0];
    expect(score.total_lines).toBe(0);
    expect(score.test_coverage).toBe("unknown");
    expect(score.documentation_quality).toBe("unknown");
    // safety_net = 0.5 (unknown tc) + 0.5 (unknown dq) = 1.0
    expect(score.safety_net).toBe(1);
    expect(score.issue_count).toBe(0);
    expect(score.weighted_issue_count).toBe(0);
  });

  it("handles single module percentile edge case", async () => {
    project = await createTestProject();

    await copyFixture("src_api.json", project.modulesDir);

    const result = await computeRiskScores(project.projectRoot);

    expect(result.scores).toHaveLength(1);
    const dist = result.risk_distribution;
    expect(dist.critical + dist.high + dist.medium + dist.low).toBe(1);
    // With n=1, p90=p75=p50 all equal the single score, so it's >= p90 → critical
    expect(dist.critical).toBe(1);
  });

  it("weights definite-confidence issues higher than low-confidence", async () => {
    project = await createTestProject();

    const makeModule = (name: string, confidence: string) => ({
      directory: name,
      total_lines: 500,
      test_coverage: "partial",
      documentation_quality: "adequate",
      internal_dependencies: [],
      external_dependencies: [],
      files: [
        {
          path: `${name}/main.py`,
          issues: Array.from({ length: 10 }, (_, i) => ({
            severity: "warning",
            confidence,
            category: "maintainability",
            description: `issue ${i + 1}`,
          })),
          functions: [],
        },
      ],
    });

    await writeFile(
      join(project.modulesDir, "mod_definite.json"),
      JSON.stringify(makeModule("mod_definite", "definite")),
    );
    await writeFile(
      join(project.modulesDir, "mod_low.json"),
      JSON.stringify(makeModule("mod_low", "low")),
    );

    const result = await computeRiskScores(project.projectRoot);

    const definiteScore = result.scores.find((s) => s.module === "mod_definite")!;
    const lowScore = result.scores.find((s) => s.module === "mod_low")!;

    // 10 * 1.0 = 10.0 vs 10 * 0.2 = 2.0
    expect(definiteScore.weighted_issue_count).toBe(10);
    expect(lowScore.weighted_issue_count).toBe(2);
    expect(definiteScore.risk_score).toBeGreaterThan(lowScore.risk_score);

    // Both should still have issue_count = 10
    expect(definiteScore.issue_count).toBe(10);
    expect(lowScore.issue_count).toBe(10);
  });

  it("defaults missing confidence to 0.5 weight", async () => {
    project = await createTestProject();

    await writeFile(
      join(project.modulesDir, "mod_no_conf.json"),
      JSON.stringify({
        directory: "mod_no_conf",
        total_lines: 100,
        test_coverage: "full",
        documentation_quality: "comprehensive",
        internal_dependencies: [],
        external_dependencies: [],
        files: [
          {
            path: "mod_no_conf/main.py",
            issues: [
              {
                severity: "warning",
                category: "maintainability",
                description: "no confidence field",
              },
              {
                severity: "warning",
                category: "maintainability",
                description: "also no confidence",
              },
            ],
            functions: [],
          },
        ],
      }),
    );

    const result = await computeRiskScores(project.projectRoot);

    // 2 issues * 0.5 (default) = 1.0
    expect(result.scores[0].weighted_issue_count).toBe(1);
    expect(result.scores[0].issue_count).toBe(2);
  });

  it("populates top_10_highest_risk correctly", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    await buildDepGraph(project.projectRoot);
    const result = await computeRiskScores(project.projectRoot);

    expect(result.top_10_highest_risk).toHaveLength(3);
    // First entry should be the highest risk module
    expect(result.top_10_highest_risk[0]).toBe(result.scores[0].module);
  });

  it("writes output file to correct location", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);

    await computeRiskScores(project.projectRoot);

    const outputPath = join(project.dataDir, "risk-scores.json");
    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as RiskScoresOutput;

    expect(parsed.scores).toHaveLength(1);
    expect(parsed.scores[0].module).toBe("src_auth");
  });

  it("scores high_complexity functions correctly", async () => {
    project = await createTestProject();

    // src_auth has 2 high-complexity functions (authenticate, check_permission)
    // and 2 medium-complexity functions
    await copyFixture("src_auth.json", project.modulesDir);

    const result = await computeRiskScores(project.projectRoot);

    const authScore = result.scores.find((s) => s.module === "src_auth")!;
    expect(authScore.high_complexity).toBe(2);
    // complexity includes high_complexity * 2
    expect(authScore.complexity).toBe(
      authScore.total_lines + authScore.weighted_issue_count + 2 * 2,
    );
  });
});

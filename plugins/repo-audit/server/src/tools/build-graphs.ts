import { readFile, readdir, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { runScript } from "../lib/subprocess.js";
import { getState, updateState, persistState, addError } from "../lib/state.js";
import { buildDepGraph } from "../scripts/build-dep-graph.js";
import { computeRiskScores } from "../scripts/compute-risk-scores.js";
import { extractVariants } from "../scripts/extract-variants.js";
import { mergeModuleFindings } from "../scripts/merge-module-findings.js";

// ----- Interfaces -----

interface BuildGraphsInput {
  includeVariantAnalysis?: boolean;
}

interface CrossModuleAgentPrompt {
  name: string;
  prompt: string;
  outputPath: string;
}

interface BuildGraphsResult {
  dependencyGraph: { modules: number; edges: number; cycles: number };
  riskScores: { highRisk: string[]; mediumRisk: string[]; lowRisk: string[] };
  variantAnalysis: { systemicPatterns: number; newInstances: number } | null;
  crossModuleAgentPrompts: CrossModuleAgentPrompt[];
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
 * Run deterministic variant grep search for single-critical issues.
 * For each single-occurrence critical issue, derive a grep pattern from
 * the description/guide_rule and search the codebase.
 */
async function runVariantSearch(
  projectRoot: string,
  auditDir: string,
): Promise<{ systemicPatterns: number; newInstances: number }> {
  const candidatesPath = join(auditDir, "data", "variant-candidates.json");

  try {
    const data = await readFile(candidatesPath, "utf-8");
    const candidates = JSON.parse(data);

    const systemicPatterns = Object.keys(candidates.systemic_patterns ?? {}).length;

    // For single-critical issues, try deterministic grep to find more instances
    const singleCriticals = candidates.single_critical ?? {};
    let newInstances = 0;
    const variantResults: Record<string, unknown[]> = {};

    for (const [rule, info] of Object.entries(singleCriticals) as [string, any][]) {
      // Derive grep pattern from the guide_rule or description
      const pattern = deriveGrepPattern(rule, info.description ?? "");
      if (!pattern) continue;

      try {
        const result = await runScript("rg", [
          "--count-matches",
          "--glob", "!node_modules/**",
          "--glob", "!.git/**",
          "--glob", "!vendor/**",
          "--glob", "!dist/**",
          "--glob", "!build/**",
          "--glob", "!.venv/**",
          "--glob", "!target/**",
          "--glob", "!sdlc-audit/**",
          pattern,
          projectRoot,
        ], {
          cwd: projectRoot,
          timeout: 15_000,
        });

        if (result.stdout.trim()) {
          const lines = result.stdout.trim().split("\n");
          // Exclude the original file from results
          const originalFile = info.file ?? "";
          const newMatches = lines.filter((l) => !l.includes(originalFile));
          if (newMatches.length > 0) {
            newInstances += newMatches.length;
            variantResults[rule] = newMatches.map((l) => {
              const parts = l.split(":");
              return {
                file: parts.slice(0, -1).join(":"),
                count: parseInt(parts[parts.length - 1], 10) || 1,
              };
            });
          }
        }
      } catch {
        // rg not found or pattern error — skip
      }
    }

    // Write variant analysis results
    const variantPath = join(auditDir, "data", "variant-analysis.json");
    await writeFile(variantPath, JSON.stringify({
      systemic_patterns: candidates.systemic_patterns,
      variant_search_results: variantResults,
      total_new_instances: newInstances,
    }, null, 2));

    return { systemicPatterns, newInstances };
  } catch {
    return { systemicPatterns: 0, newInstances: 0 };
  }
}

/**
 * Derive a grep pattern from a guide_rule identifier.
 * Maps common rule patterns to searchable regex.
 */
function deriveGrepPattern(rule: string, description: string): string | null {
  // Common patterns from guide rules
  const rulePatterns: Record<string, string> = {
    "SEC-SQL-INJECT": "\\+.*(?:SELECT|INSERT|UPDATE|DELETE|WHERE)",
    "SEC-XSS": "innerHTML|dangerouslySetInnerHTML|document\\.write",
    "SEC-HARDCODED-SECRET": "(?i)(password|api_key|secret|token)\\s*=\\s*[\"']",
    "SEC-EVAL": "eval\\(|exec\\(",
    "ERR-BARE-EXCEPT": "except\\s*:",
    "ERR-EMPTY-CATCH": "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}",
    "PERF-N-PLUS-1": "for.*\\bawait\\b.*\\bfetch\\b|for.*\\bawait\\b.*\\.find",
    "TYPE-ANY": ":\\s*any\\b|as\\s+any\\b",
  };

  // Check exact match first
  if (rulePatterns[rule]) return rulePatterns[rule];

  // Check partial match
  for (const [key, pattern] of Object.entries(rulePatterns)) {
    if (rule.includes(key) || key.includes(rule)) return pattern;
  }

  // Try to derive from description keywords
  const descLower = description.toLowerCase();
  if (descLower.includes("sql injection")) return rulePatterns["SEC-SQL-INJECT"];
  if (descLower.includes("xss") || descLower.includes("cross-site")) return rulePatterns["SEC-XSS"];
  if (descLower.includes("hardcoded") && descLower.includes("secret")) return rulePatterns["SEC-HARDCODED-SECRET"];
  if (descLower.includes("bare except")) return rulePatterns["ERR-BARE-EXCEPT"];
  if (descLower.includes("empty catch")) return rulePatterns["ERR-EMPTY-CATCH"];

  return null;
}

/**
 * Parse cross-module agent prompts from phases/cross-module-agents.md.
 */
async function parseCrossModulePrompts(
  pluginRoot: string,
  auditDir: string,
): Promise<CrossModuleAgentPrompt[]> {
  let mdContent: string;
  const agentsPath = join(pluginRoot, "phases", "cross-module-agents.md");

  try {
    mdContent = await readFile(agentsPath, "utf-8");
  } catch {
    return [];
  }

  const prompts: CrossModuleAgentPrompt[] = [];

  // Parse the markdown to extract agent sections from Stage 2
  // Each agent has: ### Agent: <Name> ... ``` <prompt> ```
  const agentSections = mdContent.split(/### Agent: /);

  for (const section of agentSections.slice(1)) {
    // Extract agent name from first line
    const nameMatch = section.match(/^(.+?)$/m);
    if (!nameMatch) continue;

    const agentName = nameMatch[1].trim();

    // Extract prompt from code block
    const codeBlockMatch = section.match(/```\n([\s\S]*?)```/);
    if (!codeBlockMatch) continue;

    const prompt = codeBlockMatch[1].trim();

    // Map agent name to output file
    const nameMap: Record<string, { key: string; file: string }> = {
      "DRY Violations": { key: "dry", file: "cross-module-dry.json" },
      "Inconsistencies": { key: "inconsistencies", file: "cross-module-inconsistencies.json" },
      "Architecture": { key: "architecture", file: "cross-module-architecture.json" },
      "Test & Documentation Coverage": { key: "coverage", file: "cross-module-coverage.json" },
    };

    const mapped = nameMap[agentName];
    if (!mapped) continue;

    prompts.push({
      name: mapped.key,
      prompt,
      outputPath: join(auditDir, "data", mapped.file),
    });
  }

  return prompts;
}

// ----- Main tool function -----

export async function buildGraphs(
  input: BuildGraphsInput,
  pluginRoot: string,
): Promise<BuildGraphsResult> {
  const state = getState();
  if (!state) {
    throw new Error("State not initialized. Call audit_discover first.");
  }

  const projectRoot = state.projectRoot;
  const auditDir = state.auditDir;
  const includeVariantAnalysis = input.includeVariantAnalysis ?? true;

  updateState({ phase: "cross-module" });

  // Step 1: Build dependency graph
  let depGraphResult = { modules: 0, edges: 0, cycles: 0 };
  try {
    const { data: depData, summary } = await buildDepGraph(projectRoot);
    const edges = Object.values(depData.module_graph).reduce(
      (sum, m) => sum + m.depends_on.length,
      0,
    );
    depGraphResult = { modules: summary.modules, edges, cycles: summary.cycles };
  } catch (err) {
    addError(
      "audit_build_graphs",
      `build-dep-graph failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 2: Compute risk scores
  let riskScoreResult: { highRisk: string[]; mediumRisk: string[]; lowRisk: string[] } = {
    highRisk: [], mediumRisk: [], lowRisk: [],
  };
  try {
    const riskData = await computeRiskScores(projectRoot);
    const scores = riskData.scores;
    const n = scores.length;

    if (n > 0) {
      const allScoreVals = scores.map((s) => s.risk_score).sort((a, b) => a - b);
      const p75 = n > 1 ? allScoreVals[Math.floor(n * 0.75)] : allScoreVals[0];
      const p50 = n > 1 ? allScoreVals[Math.floor(n * 0.5)] : allScoreVals[0];

      riskScoreResult = {
        highRisk: scores.filter((s) => s.risk_score >= p75).map((s) => s.module),
        mediumRisk: scores.filter((s) => s.risk_score >= p50 && s.risk_score < p75).map((s) => s.module),
        lowRisk: scores.filter((s) => s.risk_score < p50).map((s) => s.module),
      };
    }
  } catch (err) {
    addError(
      "audit_build_graphs",
      `compute-risk-scores failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 3: Variant analysis
  let variantResult: { systemicPatterns: number; newInstances: number } | null = null;
  if (includeVariantAnalysis) {
    try {
      await extractVariants(projectRoot);

      // Run deterministic variant search
      variantResult = await runVariantSearch(projectRoot, auditDir);
    } catch (err) {
      addError(
        "audit_build_graphs",
        `Variant analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Step 4: Merge specialist findings if any exist
  const specialistDir = join(auditDir, "specialists");
  if (await fileExists(specialistDir)) {
    try {
      const specialistFiles = await readdir(specialistDir);
      const jsonFiles = specialistFiles.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        const specialistPath = join(specialistDir, file);
        const sourceName = `specialist-${file.replace("-findings.json", "")}`;
        try {
          await mergeModuleFindings({
            projectRoot,
            findingsFile: specialistPath,
            sourceCommand: sourceName,
          });
        } catch {
          // Non-fatal — specialist merge failure shouldn't block the build
        }
      }
    } catch {
      // No specialist directory or read error — that's fine
    }
  }

  // Step 5: Parse cross-module agent prompts
  const crossModuleAgentPrompts = await parseCrossModulePrompts(pluginRoot, auditDir);

  await persistState();

  return {
    dependencyGraph: depGraphResult,
    riskScores: riskScoreResult,
    variantAnalysis: variantResult,
    crossModuleAgentPrompts,
  };
}

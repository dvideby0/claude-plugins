import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getState, updateState, persistState } from "../lib/state.js";
import { estimateTokens } from "../lib/tokens.js";

// ----- Interfaces -----

interface PlanSpecialistsInput {
  forceAll?: boolean;
}

interface SpecialistEntry {
  domain: string;
  agentFile: string;
  filesFlagged: number;
  modulesAffected: string[];
  estimatedTokens: number;
}

interface SkippedSpecialist {
  domain: string;
  reason: string;
}

interface PlanSpecialistsResult {
  specialists: SpecialistEntry[];
  skippedSpecialists: SkippedSpecialist[];
}

// ----- Domain configuration -----

interface DomainConfig {
  domain: string;
  agentFile: string;
  threshold: number;
  thresholdDescription: string;
}

const SPECIALIST_DOMAINS: DomainConfig[] = [
  { domain: "error_handling", agentFile: "error-handling-specialist", threshold: 1, thresholdDescription: "1+ files flagged" },
  { domain: "security", agentFile: "security-specialist", threshold: 1, thresholdDescription: "1+ files flagged" },
  { domain: "type_design", agentFile: "type-design-specialist", threshold: 3, thresholdDescription: "3+ files flagged" },
  { domain: "test_quality", agentFile: "test-quality-specialist", threshold: 1, thresholdDescription: "1+ files flagged" },
  { domain: "performance", agentFile: "performance-specialist", threshold: 3, thresholdDescription: "3+ performance concerns" },
  { domain: "complexity", agentFile: "complexity-specialist", threshold: 5, thresholdDescription: "5+ high-complexity functions" },
];

// ----- Helpers -----

interface TriageEntry {
  files_flagged: string[];
  reason: string;
}

interface AggregatedDomain {
  filesFlagged: string[];
  modulesAffected: string[];
  reasons: string[];
}

// ----- Main tool function -----

export async function planSpecialists(
  input: PlanSpecialistsInput,
  pluginRoot: string,
): Promise<PlanSpecialistsResult> {
  const state = getState();
  if (!state) {
    throw new Error("State not initialized. Call audit_discover first.");
  }

  const auditDir = state.auditDir;
  const forceAll = input.forceAll ?? false;

  updateState({ phase: "specialists" });

  // Read all module JSONs
  const modulesDir = join(auditDir, "modules");
  let moduleFiles: string[];
  try {
    const entries = await readdir(modulesDir);
    moduleFiles = entries.filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error("No modules directory found. Run analysis first.");
  }

  // Aggregate specialist_triage across all modules
  const aggregated = new Map<string, AggregatedDomain>();

  for (const domain of SPECIALIST_DOMAINS) {
    aggregated.set(domain.domain, {
      filesFlagged: [],
      modulesAffected: [],
      reasons: [],
    });
  }

  for (const file of moduleFiles) {
    try {
      const data = await readFile(join(modulesDir, file), "utf-8");
      const module = JSON.parse(data);
      const moduleId = module.directory ?? file.replace(/\.json$/, "");
      const triage = module.specialist_triage as Record<string, TriageEntry> | undefined;

      if (!triage) continue;

      for (const [domain, entry] of Object.entries(triage)) {
        const agg = aggregated.get(domain);
        if (!agg) continue;

        const files = entry.files_flagged ?? [];
        if (files.length > 0) {
          agg.filesFlagged.push(...files);
          if (!agg.modulesAffected.includes(moduleId)) {
            agg.modulesAffected.push(moduleId);
          }
          if (entry.reason) {
            agg.reasons.push(`${moduleId}: ${entry.reason}`);
          }
        }
      }
    } catch {
      // Skip unreadable modules
    }
  }

  // Determine which specialists to run
  const specialists: SpecialistEntry[] = [];
  const skippedSpecialists: SkippedSpecialist[] = [];

  for (const config of SPECIALIST_DOMAINS) {
    const agg = aggregated.get(config.domain)!;
    const uniqueFiles = [...new Set(agg.filesFlagged)];
    const meetsThreshold = uniqueFiles.length >= config.threshold;

    if (forceAll || meetsThreshold) {
      // Estimate tokens: ~500 per flagged file (source content) + 2000 for agent prompt + guide
      const estimatedTokens = Math.max(uniqueFiles.length * 500 + 2000, 3000);

      specialists.push({
        domain: config.domain,
        agentFile: config.agentFile,
        filesFlagged: uniqueFiles.length,
        modulesAffected: agg.modulesAffected,
        estimatedTokens,
      });
    } else {
      const reason = uniqueFiles.length === 0
        ? `No files flagged for ${config.domain.replace(/_/g, " ")}`
        : `Only ${uniqueFiles.length} files flagged (threshold: ${config.thresholdDescription})`;
      skippedSpecialists.push({ domain: config.domain, reason });
    }
  }

  // Write specialist plan
  const planPath = join(auditDir, "data", "specialist-plan.json");
  await mkdir(join(auditDir, "data"), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    specialists,
    skippedSpecialists,
    aggregatedTriage: Object.fromEntries(
      [...aggregated.entries()].map(([k, v]) => [k, {
        filesFlagged: [...new Set(v.filesFlagged)],
        modulesAffected: v.modulesAffected,
        reasons: v.reasons,
      }]),
    ),
  }, null, 2));

  // Update state
  updateState({
    specialistPlan: { specialists, skippedSpecialists },
  });

  await persistState();

  return { specialists, skippedSpecialists };
}

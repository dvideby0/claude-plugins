import { readFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getState,
  loadPersistedState,
  loadAuditMeta,
  type AuditState,
  type AuditMeta,
} from "../lib/state.js";

interface StatusResult {
  phase: string;
  projectRoot: string;
  auditDirExists: boolean;
  previousAudit: {
    exists: boolean;
    date?: string;
    type?: string;
    pluginVersion?: string;
    gitSha?: string;
    modulesAnalyzed?: number;
  } | null;
  currentProgress: {
    completedModules: number;
    failedModules: number;
    totalAssignments: number;
    completedSpecialists: number;
    errors: number;
  };
  detection: {
    languages: string[];
    frameworks: string[];
    totalDirectories: number;
  } | null;
  summary: string;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countModuleFiles(auditDir: string): Promise<number> {
  try {
    const files = await readdir(join(auditDir, "modules"));
    return files.filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function getStatus(
  projectRoot: string,
  pluginRoot: string,
): Promise<StatusResult> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const auditExists = await dirExists(auditDir);

  // Try in-memory state first, then persisted state
  let state: AuditState | null = getState();
  if (!state) {
    state = await loadPersistedState(projectRoot, pluginRoot);
  }

  // Load audit meta for previous audit info
  const meta: AuditMeta | null = await loadAuditMeta(projectRoot);

  // Load detection.json if exists
  let detectionSummary: StatusResult["detection"] = null;
  try {
    const detectionPath = join(auditDir, "data", "detection.json");
    const data = await readFile(detectionPath, "utf-8");
    const detection = JSON.parse(data);
    detectionSummary = {
      languages: detection.languages ?? [],
      frameworks: detection.frameworks ?? [],
      totalDirectories: detection.all_directories
        ? Object.keys(detection.all_directories).length
        : 0,
    };
  } catch {
    // No detection data available
  }

  const moduleCount = auditExists ? await countModuleFiles(auditDir) : 0;

  const previousAudit: StatusResult["previousAudit"] = meta
    ? {
        exists: true,
        date: meta.last_audit,
        type: meta.last_audit_type,
        pluginVersion: meta.plugin_version ?? undefined,
        gitSha: meta.git_sha ?? undefined,
        modulesAnalyzed: meta.total_modules,
      }
    : { exists: false };

  const currentProgress = {
    completedModules: state?.completedModules.length ?? moduleCount,
    failedModules: state?.failedModules.length ?? 0,
    totalAssignments: state?.moduleAssignments.length ?? 0,
    completedSpecialists: state?.completedSpecialists.length ?? 0,
    errors: state?.errors.length ?? 0,
  };

  const phase = state?.phase ?? (auditExists ? "complete" : "idle");

  // Build human-readable summary
  const summaryParts: string[] = [];
  if (phase === "idle" && !auditExists) {
    summaryParts.push("No audit has been run yet for this project.");
  } else if (phase === "idle" && auditExists) {
    summaryParts.push("Previous audit data exists but no active audit session.");
  } else if (phase === "complete") {
    summaryParts.push("Audit is complete.");
  } else {
    summaryParts.push(`Audit in progress — current phase: ${phase}.`);
  }

  if (meta) {
    summaryParts.push(
      `Last audit: ${meta.last_audit_type} on ${meta.last_audit}.`,
    );
    summaryParts.push(`Modules analyzed: ${meta.total_modules}.`);
  }

  if (detectionSummary) {
    summaryParts.push(
      `Detected: ${detectionSummary.languages.join(", ")} across ${detectionSummary.totalDirectories} directories.`,
    );
  }

  if (state?.errors.length) {
    summaryParts.push(`Errors: ${state.errors.length}.`);
  }

  return {
    phase,
    projectRoot,
    auditDirExists: auditExists,
    previousAudit,
    currentProgress,
    detection: detectionSummary,
    summary: summaryParts.join(" "),
  };
}

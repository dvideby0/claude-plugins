import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface AuditMeta {
  last_audit: string;
  last_audit_type: string;
  modules_analyzed: string[];
  total_modules: number;
  git_sha: string | null;
  plugin_version: string | null;
  detection_hash: string | null;
}

export interface DetectionData {
  languages: string[];
  frameworks: string[];
  all_directories: Record<
    string,
    {
      category: string;
      languages: string[];
      files: number;
      guide_files?: string[];
    }
  >;
  [key: string]: unknown;
}

export interface ModuleAssignment {
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

export interface SpecialistPlan {
  specialists: {
    domain: string;
    agentFile: string;
    filesFlagged: number;
    modulesAffected: string[];
    estimatedTokens: number;
  }[];
  skippedSpecialists: {
    domain: string;
    reason: string;
  }[];
}

export interface AuditError {
  tool: string;
  message: string;
  timestamp: string;
}

export type AuditPhase =
  | "idle"
  | "discovering"
  | "pre-analysis"
  | "analyzing"
  | "specialists"
  | "cross-module"
  | "assembling"
  | "complete";

export interface AuditState {
  projectRoot: string;
  pluginRoot: string;
  auditDir: string;
  phase: AuditPhase;
  detection: DetectionData | null;
  toolAvailability: Record<string, boolean>;
  moduleAssignments: ModuleAssignment[];
  completedModules: string[];
  failedModules: string[];
  specialistPlan: SpecialistPlan | null;
  completedSpecialists: string[];
  incrementalMode: boolean;
  previousMeta: AuditMeta | null;
  modulesToReanalyze: string[] | null;
  errors: AuditError[];
}

function createDefaultState(
  projectRoot: string,
  pluginRoot: string,
): AuditState {
  return {
    projectRoot,
    pluginRoot,
    auditDir: join(projectRoot, "sdlc-audit"),
    phase: "idle",
    detection: null,
    toolAvailability: {},
    moduleAssignments: [],
    completedModules: [],
    failedModules: [],
    specialistPlan: null,
    completedSpecialists: [],
    incrementalMode: false,
    previousMeta: null,
    modulesToReanalyze: null,
    errors: [],
  };
}

let currentState: AuditState | null = null;

export function getState(): AuditState | null {
  return currentState;
}

export function initState(projectRoot: string, pluginRoot: string): AuditState {
  currentState = createDefaultState(projectRoot, pluginRoot);
  return currentState;
}

export function updateState(updates: Partial<AuditState>): AuditState {
  if (!currentState) {
    throw new Error("State not initialized. Call initState first.");
  }
  Object.assign(currentState, updates);
  return currentState;
}

export function addError(tool: string, message: string): void {
  if (!currentState) return;
  currentState.errors.push({
    tool,
    message,
    timestamp: new Date().toISOString(),
  });
}

export async function persistState(): Promise<void> {
  if (!currentState) return;
  const stateDir = join(currentState.auditDir, "data");
  await mkdir(stateDir, { recursive: true });
  const statePath = join(stateDir, ".audit-state.json");
  await writeFile(statePath, JSON.stringify(currentState, null, 2));
}

export async function loadPersistedState(
  projectRoot: string,
  pluginRoot: string,
): Promise<AuditState | null> {
  const statePath = join(projectRoot, "sdlc-audit", "data", ".audit-state.json");
  try {
    const data = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(data) as AuditState;
    // Ensure paths match the current invocation
    parsed.projectRoot = projectRoot;
    parsed.pluginRoot = pluginRoot;
    parsed.auditDir = join(projectRoot, "sdlc-audit");
    currentState = parsed;
    return currentState;
  } catch {
    return null;
  }
}

export async function loadAuditMeta(
  projectRoot: string,
): Promise<AuditMeta | null> {
  const metaPath = join(projectRoot, "sdlc-audit", "data", ".audit-meta.json");
  try {
    const data = await readFile(metaPath, "utf-8");
    return JSON.parse(data) as AuditMeta;
  } catch {
    return null;
  }
}

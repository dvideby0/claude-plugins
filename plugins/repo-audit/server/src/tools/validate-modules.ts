import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { getState, updateState, persistState, addError } from "../lib/state.js";
import { validateModuleJson } from "../scripts/validate-module-json.js";

// ----- Interfaces -----

interface ValidateModulesInput {
  modules?: string[];
}

interface FailedModule {
  moduleId: string;
  errors: string[];
}

interface ValidateModulesResult {
  total: number;
  passed: number;
  failed: FailedModule[];
}

// ----- Main tool function -----

export async function validateModules(
  input: ValidateModulesInput,
  pluginRoot: string,
): Promise<ValidateModulesResult> {
  const state = getState();
  if (!state) {
    throw new Error("State not initialized. Call audit_discover first.");
  }

  const projectRoot = state.projectRoot;
  const auditDir = state.auditDir;

  // Run validation
  let results: { validated: number; passed: number; failed: number; errors: { file: string; errors: string[] }[] };
  try {
    results = await validateModuleJson(projectRoot);
  } catch (err) {
    addError(
      "audit_validate_modules",
      `validate-module-json failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { total: 0, passed: 0, failed: [] };
  }

  // Build failed module list
  const failed: FailedModule[] = (results.errors ?? []).map((e) => ({
    moduleId: e.file.replace(/\.json$/, ""),
    errors: e.errors,
  }));

  // Filter by requested modules if specified
  let filteredFailed = failed;
  if (input.modules && input.modules.length > 0) {
    const requestedSet = new Set(input.modules);
    filteredFailed = failed.filter((f) => requestedSet.has(f.moduleId));
  }

  // Update state with passed/failed modules
  const passedModules = results.validated - results.failed;
  const failedModuleIds = filteredFailed.map((f) => f.moduleId);

  // Update completedModules/failedModules in state
  const currentCompleted = new Set(state.completedModules);
  const currentFailed = new Set(state.failedModules);

  // All modules that passed validation are "completed" (structurally valid)
  // We don't know exactly which ones passed from the results file,
  // but we know which ones failed
  for (const f of failedModuleIds) {
    currentFailed.add(f);
    currentCompleted.delete(f);
  }

  updateState({
    completedModules: [...currentCompleted],
    failedModules: [...currentFailed],
  });

  await persistState();

  return {
    total: results.validated,
    passed: passedModules,
    failed: filteredFailed,
  };
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  runDetection,
  readDetectionJson,
  writeDetectionJson,
  type DetectionResult,
} from "../lib/detection.js";
import {
  initState,
  updateState,
  loadAuditMeta,
  persistState,
  addError,
  type AuditMeta,
  type DetectionData,
} from "../lib/state.js";
import { checkPrereqs } from "../scripts/check-prereqs.js";
import type { ToolAvailability } from "../lib/types.js";

/**
 * Convert DetectionResult (from runDetection) to DetectionData (for state storage).
 * These types differ in field names and structure.
 */
function toDetectionData(det: DetectionResult): DetectionData {
  const allDirs: DetectionData["all_directories"] = {};
  for (const [dir, info] of Object.entries(det.all_directories)) {
    allDirs[dir] = {
      category: info.category,
      languages: info.languages,
      files: info.est_files,
      guide_files: info.guide_files,
    };
  }

  return {
    languages: det.primary_languages,
    frameworks: Object.keys(det.frameworks),
    all_directories: allDirs,
    secondary_languages: det.secondary_languages,
    tooling: det.tooling,
    monorepo: det.monorepo,
    package_managers: det.package_managers,
    total_source_files: det.total_source_files,
    total_directories: det.total_directories,
  };
}

interface DiscoverInput {
  projectRoot?: string;
  force?: boolean;
}

interface PreviousAuditInfo {
  exists: boolean;
  date?: string;
  type?: string;
  versionMatch?: boolean;
  hashMatch?: boolean;
  modulesAnalyzed?: number;
}

interface DiscoverResult {
  languages: string[];
  frameworks: Record<string, string[]>;
  totalDirectories: number;
  totalFiles: number;
  toolsMissing: string[];
  previousAudit: PreviousAuditInfo | null;
  monorepo: boolean;
  packageManagers: Record<string, string>;
  detectionPath: string;
}

async function getCurrentPluginVersion(pluginRoot: string): Promise<string | null> {
  try {
    const data = await readFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      "utf-8",
    );
    const pkg = JSON.parse(data);
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function computeDetectionHash(
  auditDir: string,
): Promise<string | null> {
  try {
    const raw = await readFile(join(auditDir, "data", "detection.json"), "utf-8");
    const detection = JSON.parse(raw);
    const allDirs = (detection.all_directories ?? {}) as Record<
      string,
      { category?: string; languages?: string[] }
    >;

    const entries = Object.entries(allDirs)
      .map(([key, val]) => ({
        key,
        category: val.category ?? "",
        languages: val.languages ?? [],
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    const canonical = JSON.stringify(entries);
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return null;
  }
}

export async function discover(
  input: DiscoverInput,
  pluginRoot: string,
): Promise<DiscoverResult> {
  const projectRoot = input.projectRoot ?? process.cwd();
  const force = input.force ?? false;
  const auditDir = join(projectRoot, "sdlc-audit");

  // Initialize state
  const state = initState(projectRoot, pluginRoot);
  updateState({ phase: "discovering" });

  // Step 1: Run prerequisites check
  let toolAvailability: ToolAvailability | null = null;
  try {
    toolAvailability = await checkPrereqs(projectRoot);
  } catch (err) {
    addError(
      "audit_discover",
      `Failed to check prerequisites: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Build tool availability map for state
  const toolMap: Record<string, boolean> = {};
  if (toolAvailability) {
    for (const [name, info] of Object.entries(toolAvailability.tools ?? {})) {
      toolMap[name] = info.available;
    }
    for (const [name, info] of Object.entries(toolAvailability.project_tools ?? {})) {
      toolMap[name] = info.available;
    }
  }
  updateState({ toolAvailability: toolMap });

  // Step 2: Check for cached detection.json
  let detection: DetectionResult | null = null;
  if (!force) {
    detection = await readDetectionJson(auditDir);
  }

  // Step 3: Run detection if not cached
  if (!detection) {
    try {
      detection = await runDetection(projectRoot, pluginRoot);

      // Merge tooling info from check-prereqs if available
      if (toolAvailability) {
        const tooling: Record<string, unknown> = {};
        const linters: string[] = [];
        const formatters: string[] = [];
        const testing: string[] = [];

        const projectTools = toolAvailability.project_tools ?? {};
        if (projectTools["eslint"]?.available) linters.push("eslint");
        if (projectTools["biome"]?.available) linters.push("biome");
        if (projectTools["ruff"]?.available) linters.push("ruff");
        if (projectTools["mypy"]?.available) linters.push("mypy");
        if (projectTools["go_vet"]?.available) linters.push("go-vet");
        if (projectTools["cargo_clippy"]?.available) linters.push("clippy");

        if (linters.length > 0) tooling["linters"] = linters;
        if (formatters.length > 0) tooling["formatters"] = formatters;
        if (testing.length > 0) tooling["testing"] = testing;

        detection.tooling = tooling;
      }

      await writeDetectionJson(auditDir, detection);
    } catch (err) {
      addError(
        "audit_discover",
        `Detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  updateState({ detection: toDetectionData(detection) });

  // Step 4: Check for previous audit
  let previousAudit: PreviousAuditInfo | null = null;
  const meta: AuditMeta | null = await loadAuditMeta(projectRoot);

  if (meta) {
    const currentVersion = await getCurrentPluginVersion(pluginRoot);
    const currentHash = await computeDetectionHash(auditDir);

    previousAudit = {
      exists: true,
      date: meta.last_audit,
      type: meta.last_audit_type,
      modulesAnalyzed: meta.total_modules,
      versionMatch:
        meta.plugin_version != null && currentVersion != null
          ? meta.plugin_version === currentVersion
          : undefined,
      hashMatch:
        meta.detection_hash != null && currentHash != null
          ? meta.detection_hash === currentHash
          : undefined,
    };

    updateState({ previousMeta: meta });
  } else {
    previousAudit = { exists: false };
  }

  // Collect missing tools
  const toolsMissing: string[] = [];
  if (toolAvailability) {
    for (const [name, info] of Object.entries(toolAvailability.tools ?? {})) {
      if (!info.available) toolsMissing.push(name);
    }
  }

  await persistState();

  return {
    languages: detection.primary_languages,
    frameworks: detection.frameworks,
    totalDirectories: detection.total_directories,
    totalFiles: detection.total_source_files,
    toolsMissing,
    previousAudit,
    monorepo: detection.monorepo,
    packageManagers: detection.package_managers,
    detectionPath: join(auditDir, "data", "detection.json"),
  };
}

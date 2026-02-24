import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runBashScript } from "../lib/subprocess.js";
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
} from "../lib/state.js";

interface ToolAvailability {
  tools: Record<string, { available: boolean; path?: string }>;
  project_tools: Record<string, { available: boolean }>;
  install_commands: {
    all_missing: string | null;
    per_tool: Record<string, string>;
  };
  [key: string]: unknown;
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
  jqAvailable: boolean;
  previousAudit: PreviousAuditInfo | null;
  monorepo: boolean;
  packageManagers: Record<string, string>;
  detectionPath: string;
}

async function readToolAvailability(
  auditDir: string,
): Promise<ToolAvailability | null> {
  try {
    const data = await readFile(
      join(auditDir, "data", "tool-availability.json"),
      "utf-8",
    );
    return JSON.parse(data) as ToolAvailability;
  } catch {
    return null;
  }
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
    // Use jq + shasum to compute hash the same way write-audit-meta.sh does
    const { execSync } = await import("node:child_process");
    const cmd = `jq -S '.all_directories | to_entries | map({key: .key, category: .value.category, languages: .value.languages}) | sort_by(.key)' "${join(auditDir, "data", "detection.json")}" 2>/dev/null | shasum -a 256 | cut -d' ' -f1`;
    const result = execSync(cmd, { encoding: "utf-8" }).trim();
    return result || null;
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
    const prereqScript = join(pluginRoot, "scripts", "check-prereqs.sh");
    const result = await runBashScript(prereqScript, [projectRoot], {
      cwd: projectRoot,
      timeout: 30_000,
    });

    // Read the tool-availability.json it wrote
    toolAvailability = await readToolAvailability(auditDir);

    if (result.exitCode !== 0) {
      // jq is missing — hard requirement
      addError(
        "audit_discover",
        "jq is required but not installed. check-prereqs.sh exited with non-zero status.",
      );
    }
  } catch (err) {
    addError(
      "audit_discover",
      `Failed to run check-prereqs.sh: ${err instanceof Error ? err.message : String(err)}`,
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

  updateState({ detection: detection as any });

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

  const jqAvailable = toolMap["jq"] ?? false;

  await persistState();

  return {
    languages: detection.primary_languages,
    frameworks: detection.frameworks,
    totalDirectories: detection.total_directories,
    totalFiles: detection.total_source_files,
    toolsMissing,
    jqAvailable,
    previousAudit,
    monorepo: detection.monorepo,
    packageManagers: detection.package_managers,
    detectionPath: join(auditDir, "data", "detection.json"),
  };
}

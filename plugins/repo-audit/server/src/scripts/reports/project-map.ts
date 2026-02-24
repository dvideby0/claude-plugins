/**
 * Project Map Assembler.
 * Migrated from scripts/assemble-project-map.sh (171 LOC).
 *
 * Reads detection.json, metrics.json, dependency-data.json, git outputs,
 * and module JSONs to produce sdlc-audit/reports/PROJECT_MAP.md.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readAllModules } from "../../lib/modules.js";
import { markdownTable, safeReadJson, REPORT_FOOTER, bulletList } from "./common.js";
import type { DependencyData } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Types for detection and metrics
// ---------------------------------------------------------------------------

interface DetectionJson {
  primary_languages?: string[];
  secondary_languages?: string[];
  frameworks?: Record<string, string[]>;
  all_directories?: Record<string, {
    category?: string;
    languages?: string[];
  }>;
  tooling?: Record<string, string | string[]>;
  monorepo?: boolean;
  total_source_files?: number;
  total_directories?: number;
}

interface MetricsJson {
  [key: string]: {
    nFiles?: number;
    code?: number;
    comment?: number;
    blank?: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMetricsTable(metrics: MetricsJson): string {
  const entries = Object.entries(metrics)
    .filter(([key]) => key !== "header" && key !== "SUM")
    .sort(([, a], [, b]) => (b.code ?? 0) - (a.code ?? 0));

  if (entries.length === 0) return "No metrics data available.";

  const rows = entries.map(([lang, data]) => [
    lang,
    String(data.nFiles ?? 0),
    String(data.code ?? 0),
    String(data.comment ?? 0),
    String(data.blank ?? 0),
  ]);

  const table = markdownTable(
    ["Language", "Files", "Code", "Comment", "Blank"],
    rows,
  );

  const sum = metrics["SUM"];
  if (sum) {
    return `${table}\n\n**Total:** ${sum.nFiles ?? 0} files, ${sum.code ?? 0} code lines, ${sum.comment ?? 0} comment lines`;
  }
  return table;
}

async function readGitHotspots(dataDir: string): Promise<string> {
  try {
    const data = await readFile(join(dataDir, "git-hotspots.txt"), "utf-8");
    const lines = data.trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) return "No hotspot data available.";

    // Try to parse as JSON-ish format (array of {changes, file})
    try {
      const hotspots = JSON.parse(data);
      if (Array.isArray(hotspots)) {
        return hotspots
          .slice(0, 30)
          .map((h: { changes: number; file: string }) => `- ${h.file}: ${h.changes} changes`)
          .join("\n");
      }
    } catch {
      // Not JSON, try line-by-line format
    }

    // Plain text format: "count file"
    return lines
      .slice(0, 30)
      .map((l) => `- ${l.trim()}`)
      .join("\n");
  } catch {
    return "No git hotspot data available.";
  }
}

async function readBusFactor(dataDir: string): Promise<string> {
  try {
    const data = await readFile(join(dataDir, "git-busfactor.txt"), "utf-8");
    const lines = data.trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) return "";
    return lines.map((l) => `- ${l.trim()}`).join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function assembleProjectMap(projectRoot: string): Promise<void> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const dataDir = join(auditDir, "data");
  const modulesDir = join(auditDir, "modules");
  const reportsDir = join(auditDir, "reports");

  await mkdir(reportsDir, { recursive: true });

  const detection = await safeReadJson<DetectionJson>(readFile, join(dataDir, "detection.json"));
  if (!detection) {
    await writeFile(
      join(reportsDir, "PROJECT_MAP.md"),
      "# Project Map\n\nNo detection data available.\n" + REPORT_FOOTER,
    );
    return;
  }

  const lines: string[] = [];

  // Header
  lines.push("# Project Map\n");

  // Languages
  lines.push("## Languages\n");
  const primary = detection.primary_languages ?? [];
  const secondary = detection.secondary_languages ?? [];
  if (primary.length > 0) {
    lines.push(`**Primary:** ${primary.join(", ")}`);
  }
  if (secondary.length > 0) {
    lines.push(`**Secondary:** ${secondary.join(", ")}`);
  }
  if (primary.length === 0 && secondary.length === 0) {
    lines.push("No languages detected.");
  }
  lines.push("");

  // Frameworks
  const frameworks = detection.frameworks ?? {};
  if (Object.keys(frameworks).length > 0) {
    lines.push("## Frameworks\n");
    for (const [name, details] of Object.entries(frameworks)) {
      if (Array.isArray(details) && details.length > 0) {
        lines.push(`- **${name}**: ${details.join(", ")}`);
      } else {
        lines.push(`- **${name}**`);
      }
    }
    lines.push("");
  }

  // Code metrics
  const metrics = await safeReadJson<MetricsJson>(readFile, join(dataDir, "metrics.json"));
  if (metrics) {
    lines.push("## Code Metrics\n");
    lines.push(formatMetricsTable(metrics));
    lines.push("");
  }

  // Directory structure
  const dirs = detection.all_directories ?? {};
  if (Object.keys(dirs).length > 0) {
    lines.push("## Directory Structure\n");
    for (const [dir, info] of Object.entries(dirs).sort(([a], [b]) => a.localeCompare(b))) {
      const parts: string[] = [];
      if (info.category) parts.push(info.category);
      if (info.languages && info.languages.length > 0) {
        parts.push(info.languages.join(", "));
      }
      lines.push(`- \`${dir}/\` — ${parts.join(" | ") || "unknown"}`);
    }
    lines.push("");
  }

  // Tooling
  const tooling = detection.tooling ?? {};
  if (Object.keys(tooling).length > 0) {
    lines.push("## Tooling\n");
    for (const [name, value] of Object.entries(tooling)) {
      if (Array.isArray(value)) {
        lines.push(`- **${name}**: ${value.join(", ")}`);
      } else {
        lines.push(`- **${name}**: ${String(value)}`);
      }
    }
    lines.push("");
  }

  // Module dependencies
  const depData = await safeReadJson<DependencyData>(readFile, join(dataDir, "dependency-data.json"));
  if (depData) {
    lines.push("## Module Dependencies\n");
    const graph = depData.module_graph ?? {};
    for (const [mod, info] of Object.entries(graph).sort(([a], [b]) => a.localeCompare(b))) {
      const deps = info.depends_on.length > 0 ? info.depends_on.join(", ") : "(none)";
      lines.push(`- \`${mod}\` → ${deps} (fan_in=${info.fan_in})`);
    }
    const cycles = depData.circular_dependencies ?? [];
    if (cycles.length > 0) {
      lines.push(`\n**Circular dependencies:** ${cycles.map((c) => c.join(" → ")).join("; ")}`);
    }
    const hubs = depData.hub_modules ?? [];
    if (hubs.length > 0) {
      lines.push(`**Hub modules:** ${hubs.join(", ")}`);
    }
    lines.push("");
  }

  // Git activity
  const hotspots = await readGitHotspots(dataDir);
  const busFactor = await readBusFactor(dataDir);
  if (hotspots !== "No git hotspot data available." || busFactor) {
    lines.push("## Repository Activity\n");
    if (hotspots !== "No git hotspot data available.") {
      lines.push("### Hotspots (most frequently changed files)\n");
      lines.push(hotspots);
      lines.push("");
    }
    if (busFactor) {
      lines.push("### Bus Factor (contributors per module)\n");
      lines.push(busFactor);
      lines.push("");
    }
  }

  // Module purposes
  const modules = await readAllModules(modulesDir);
  const modulesWithPurpose = modules.filter((m) => m.data.purpose);
  if (modulesWithPurpose.length > 0) {
    lines.push("## Module Purposes\n");
    for (const mod of modulesWithPurpose) {
      lines.push(`- **${mod.data.directory}**: ${mod.data.purpose}`);
    }
    lines.push("");
  }

  lines.push(REPORT_FOOTER);

  await writeFile(join(reportsDir, "PROJECT_MAP.md"), lines.join("\n"));
}

/**
 * Dependency Graph Report Assembler.
 * Migrated from scripts/assemble-dep-graph.sh (142 LOC).
 *
 * Reads dependency-data.json and produces sdlc-audit/reports/DEPENDENCY_GRAPH.md.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { markdownTable, safeReadJson, REPORT_FOOTER } from "./common.js";
import type { DependencyData } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function assembleDepGraphReport(projectRoot: string): Promise<void> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const dataDir = join(auditDir, "data");
  const reportsDir = join(auditDir, "reports");

  await mkdir(reportsDir, { recursive: true });

  const depData = await safeReadJson<DependencyData>(readFile, join(dataDir, "dependency-data.json"));
  if (!depData) {
    await writeFile(
      join(reportsDir, "DEPENDENCY_GRAPH.md"),
      "# Dependency Graph\n\nNo dependency data available.\n" + REPORT_FOOTER,
    );
    return;
  }

  const graph = depData.module_graph ?? {};
  const moduleCount = Object.keys(graph).length;
  const externalDeps = depData.external_dependencies ?? {};
  const externalCount = Object.keys(externalDeps).length;
  const cycles = depData.circular_dependencies ?? [];
  const hubs = depData.hub_modules ?? [];
  const orphans = depData.orphan_modules ?? [];

  const lines: string[] = [];

  // Header
  lines.push("# Dependency Graph\n");
  lines.push(
    `**${moduleCount} modules**, ${externalCount} external dependencies, ${cycles.length} circular dependencies\n`,
  );

  // Internal dependencies
  lines.push("## Internal Dependencies\n");
  lines.push("```");
  for (const [mod, info] of Object.entries(graph).sort(([a], [b]) => a.localeCompare(b))) {
    const deps = info.depends_on.length > 0 ? info.depends_on.join(", ") : "(none)";
    lines.push(`${mod} → ${deps}  [fan_in=${info.fan_in}, fan_out=${info.fan_out}]`);
  }
  lines.push("```\n");

  // Circular dependencies
  if (cycles.length > 0) {
    lines.push("## Circular Dependencies\n");
    for (const cycle of cycles) {
      lines.push(`- ${cycle.join(" → ")}`);
    }
    lines.push("");
  }

  // Hub modules
  if (hubs.length > 0) {
    lines.push("## Hub Modules\n");
    for (const hub of hubs) {
      const info = graph[hub];
      if (info) {
        lines.push(
          `- **${hub}**: fan_in=${info.fan_in}, depended on by: ${info.depended_on_by.join(", ")}`,
        );
      } else {
        lines.push(`- **${hub}**`);
      }
    }
    lines.push("");
  }

  // Orphan modules
  if (orphans.length > 0) {
    lines.push("## Orphan Modules\n");
    for (const orphan of orphans) {
      lines.push(`- ${orphan}`);
    }
    lines.push("");
  }

  // External dependencies
  if (externalCount > 0) {
    lines.push("## External Dependencies\n");
    // Sort by usage count (descending)
    const sorted = Object.entries(externalDeps).sort(
      ([, a], [, b]) => b.length - a.length,
    );
    const rows = sorted.map(([pkg, users]) => [pkg, users.join(", ")]);
    lines.push(markdownTable(["Package", "Used by"], rows));
    lines.push("");

    // Duplicates (used by 3+ modules)
    const duplicates = sorted.filter(([, users]) => users.length >= 3);
    if (duplicates.length > 0) {
      lines.push("### Potential Duplicate Dependencies\n");
      lines.push("Packages used by 3 or more modules (consolidation candidates):\n");
      for (const [pkg, users] of duplicates) {
        lines.push(`- **${pkg}**: used by ${users.length} modules`);
      }
      lines.push("");
    } else {
      lines.push("### Potential Duplicate Dependencies\n");
      lines.push("None found.\n");
    }
  }

  // Placeholder for cross-module interpretation
  lines.push("<!-- DEP_GRAPH_INTERPRETATION_PLACEHOLDER -->");
  lines.push(REPORT_FOOTER);

  await writeFile(join(reportsDir, "DEPENDENCY_GRAPH.md"), lines.join("\n"));
}

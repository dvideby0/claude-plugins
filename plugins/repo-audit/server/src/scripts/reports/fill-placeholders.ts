/**
 * Cross-Module Placeholder Filler.
 * Migrated from scripts/fill-cross-module-placeholders.sh (353 LOC).
 *
 * Replaces placeholder HTML comments in generated reports with formatted
 * markdown content from cross-module JSON files.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { safeReadJson } from "./common.js";
import type {
  CrossModuleDry,
  CrossModuleInconsistencies,
  CrossModuleArchitecture,
  CrossModuleCoverage,
} from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a placeholder comment in a file with new content.
 * If content is empty, the placeholder line is removed.
 */
async function replacePlaceholder(
  filePath: string,
  placeholder: string,
  content: string,
): Promise<void> {
  if (!(await fileExists(filePath))) return;

  const data = await readFile(filePath, "utf-8");
  const marker = `<!-- ${placeholder} -->`;

  if (!data.includes(marker)) return;

  const replaced = content.trim()
    ? data.replace(marker, content.trim())
    : data.replace(marker, "");

  await writeFile(filePath, replaced);
}

// ---------------------------------------------------------------------------
// Per-report fillers
// ---------------------------------------------------------------------------

function buildAuditReportContent(
  dry: CrossModuleDry | null,
  inconsistencies: CrossModuleInconsistencies | null,
  architecture: CrossModuleArchitecture | null,
): string {
  const sections: string[] = [];

  const hasDry = (dry?.duplications?.length ?? 0) > 0;
  const hasInc = (inconsistencies?.inconsistencies?.length ?? 0) > 0;
  const hasArch = (architecture?.architecture_issues?.length ?? 0) > 0;

  if (!hasDry && !hasInc && !hasArch) return "";

  sections.push("## Cross-Module Analysis\n");

  // DRY violations
  if (hasDry) {
    sections.push("### DRY Violations\n");
    for (const dup of dry!.duplications) {
      sections.push(`- **${dup.description}**`);
      if (dup.locations.length > 0) {
        sections.push(`  Locations: ${dup.locations.join(", ")}`);
      }
      if (dup.suggestion) {
        sections.push(`  > ${dup.suggestion}`);
      }
    }
    sections.push("");
  }

  // Inconsistencies
  if (hasInc) {
    sections.push("### Inconsistencies\n");
    for (const inc of inconsistencies!.inconsistencies) {
      const ptype = inc.pattern_type ? `[${inc.pattern_type}] ` : "";
      sections.push(`- **${ptype}${inc.description}**`);
      if (inc.examples.length > 0) {
        const exNames = inc.examples.map((e) =>
          typeof e === "string" ? e : e.module,
        );
        sections.push(`  Examples: ${exNames.join(", ")}`);
      }
      if (inc.recommendation) {
        sections.push(`  > ${inc.recommendation}`);
      }
    }
    sections.push("");
  }

  // Architecture issues
  if (hasArch) {
    sections.push("### Architecture Issues\n");
    for (const arch of architecture!.architecture_issues) {
      const atype = arch.type ? `[${arch.type}] ` : "";
      sections.push(`- **${atype}${arch.description}**`);
      const affectedModules = arch.affected_modules ?? arch.modules ?? [];
      if (affectedModules.length > 0) {
        sections.push(`  Affected modules: ${affectedModules.join(", ")}`);
      }
      if (arch.suggestion) {
        sections.push(`  > ${arch.suggestion}`);
      }
    }
    sections.push("");
  }

  return sections.join("\n");
}

function buildTechDebtDry(dry: CrossModuleDry | null): string {
  if (!dry || dry.duplications.length === 0) return "";

  const lines: string[] = [];
  for (const dup of dry.duplications) {
    lines.push(`- ${dup.description}`);
    if (dup.locations.length > 0) {
      lines.push(`  Locations: ${dup.locations.join(", ")}`);
    }
    if (dup.suggestion) {
      lines.push(`  > ${dup.suggestion}`);
    }
  }
  return lines.join("\n");
}

function buildTechDebtArch(architecture: CrossModuleArchitecture | null): string {
  if (!architecture || architecture.architecture_issues.length === 0) return "";

  const lines: string[] = [];
  for (const arch of architecture.architecture_issues) {
    lines.push(`- **${arch.description}**`);
    const affectedModules = arch.affected_modules ?? arch.modules ?? [];
    if (affectedModules.length > 0) {
      lines.push(`  Affected: ${affectedModules.join(", ")}`);
    }
    if (arch.suggestion) {
      lines.push(`  > ${arch.suggestion}`);
    }
  }
  return lines.join("\n");
}

function buildDepGraphInterpretation(architecture: CrossModuleArchitecture | null): string {
  if (!architecture?.dependency_interpretation && !architecture?.duplicate_externals) return "";

  const sections: string[] = [];
  const interp = architecture.dependency_interpretation;

  if (interp?.problematic_cycles && interp.problematic_cycles.length > 0) {
    sections.push("### Problematic Cycles\n");
    for (const cycle of interp.problematic_cycles) {
      sections.push(`- ${cycle.cycle.join(" → ")}`);
      sections.push(`  > ${cycle.reason}`);
    }
    sections.push("");
  }

  if (interp?.hub_assessment && interp.hub_assessment.length > 0) {
    sections.push("### Hub Assessment\n");
    for (const hub of interp.hub_assessment) {
      sections.push(`- **${hub.module}**: ${hub.assessment}`);
    }
    sections.push("");
  }

  if (interp?.decoupling_suggestions && interp.decoupling_suggestions.length > 0) {
    sections.push("### Decoupling Suggestions\n");
    for (const suggestion of interp.decoupling_suggestions) {
      sections.push(`- ${suggestion}`);
    }
    sections.push("");
  }

  if (architecture.duplicate_externals && architecture.duplicate_externals.length > 0) {
    sections.push("### Duplicate External Dependencies\n");
    for (const dup of architecture.duplicate_externals) {
      sections.push(`- **${dup.package}**: ${dup.issue}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

function buildCoverageGaps(coverage: CrossModuleCoverage | null): string {
  if (!coverage?.test_gaps || coverage.test_gaps.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Coverage Gap Analysis\n");

  // Sort by priority: critical first
  const sorted = [...coverage.test_gaps].sort((a, b) => {
    const pOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return (pOrder[a.priority ?? "medium"] ?? 2) - (pOrder[b.priority ?? "medium"] ?? 2);
  });

  for (const gap of sorted) {
    const priority = gap.priority ?? "medium";
    lines.push(`- **${gap.module}** [${priority}]`);
    if (gap.description) {
      lines.push(`  ${gap.description}`);
    }
    if (gap.risk_note) {
      lines.push(`  > ${gap.risk_note}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function fillCrossModulePlaceholders(projectRoot: string): Promise<void> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const dataDir = join(auditDir, "data");
  const reportsDir = join(auditDir, "reports");

  // Load all cross-module data
  const dry = await safeReadJson<CrossModuleDry>(readFile, join(dataDir, "cross-module-dry.json"));
  const inconsistencies = await safeReadJson<CrossModuleInconsistencies>(
    readFile,
    join(dataDir, "cross-module-inconsistencies.json"),
  );
  const architecture = await safeReadJson<CrossModuleArchitecture>(
    readFile,
    join(dataDir, "cross-module-architecture.json"),
  );
  const coverage = await safeReadJson<CrossModuleCoverage>(
    readFile,
    join(dataDir, "cross-module-coverage.json"),
  );

  // Fill AUDIT_REPORT.md
  await replacePlaceholder(
    join(reportsDir, "AUDIT_REPORT.md"),
    "CROSS_MODULE_PLACEHOLDER",
    buildAuditReportContent(dry, inconsistencies, architecture),
  );

  // Fill TECH_DEBT.md (two placeholders)
  await replacePlaceholder(
    join(reportsDir, "TECH_DEBT.md"),
    "DRY_VIOLATIONS_PLACEHOLDER",
    buildTechDebtDry(dry),
  );
  await replacePlaceholder(
    join(reportsDir, "TECH_DEBT.md"),
    "ARCHITECTURE_ISSUES_PLACEHOLDER",
    buildTechDebtArch(architecture),
  );

  // Fill DEPENDENCY_GRAPH.md
  await replacePlaceholder(
    join(reportsDir, "DEPENDENCY_GRAPH.md"),
    "DEP_GRAPH_INTERPRETATION_PLACEHOLDER",
    buildDepGraphInterpretation(architecture),
  );

  // Fill TEST_COVERAGE_MAP.md
  await replacePlaceholder(
    join(reportsDir, "TEST_COVERAGE_MAP.md"),
    "COVERAGE_GAPS_PLACEHOLDER",
    buildCoverageGaps(coverage),
  );
}

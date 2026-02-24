/**
 * Audit Report Assembler.
 * Migrated from scripts/assemble-audit-report.sh (248 LOC).
 *
 * Reads module JSONs, tool outputs, variant analysis, and metrics
 * to produce sdlc-audit/reports/AUDIT_REPORT.md.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readAllModules } from "../../lib/modules.js";
import { markdownTable, safeReadJson, REPORT_FOOTER } from "./common.js";
import type {
  ModuleJson,
  ModuleIssue,
  VariantCandidates,
} from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnrichedIssue {
  file_path: string;
  file_language?: string;
  severity: string;
  category: string;
  description: string;
  suggestion?: string;
  line_range?: string | [number, number];
  guide_rule?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenIssues(modules: Array<{ data: ModuleJson }>): EnrichedIssue[] {
  const issues: EnrichedIssue[] = [];
  for (const { data } of modules) {
    for (const file of data.files ?? []) {
      for (const issue of file.issues ?? []) {
        issues.push({
          file_path: file.path,
          file_language: file.language,
          severity: issue.severity ?? "warning",
          category: issue.category ?? "maintainability",
          description: issue.description,
          suggestion: issue.suggestion,
          line_range: issue.line_range,
          guide_rule: issue.guide_rule,
        });
      }
    }
  }
  return issues;
}

function severityOrder(sev: string): number {
  if (sev === "critical") return 0;
  if (sev === "warning") return 1;
  return 2; // info
}

function buildSummaryTable(issues: EnrichedIssue[]): string {
  const categories = new Set<string>();
  const counts = new Map<string, Map<string, number>>();

  for (const issue of issues) {
    categories.add(issue.category);
    const sevMap = counts.get(issue.severity) ?? new Map<string, number>();
    sevMap.set(issue.category, (sevMap.get(issue.category) ?? 0) + 1);
    counts.set(issue.severity, sevMap);
  }

  const sortedCats = [...categories].sort();
  const headers = ["Severity", ...sortedCats, "Total"];
  const rows: string[][] = [];

  for (const sev of ["critical", "warning", "info"]) {
    const sevMap = counts.get(sev);
    if (!sevMap) continue;
    const row = [sev];
    let total = 0;
    for (const cat of sortedCats) {
      const n = sevMap.get(cat) ?? 0;
      row.push(String(n));
      total += n;
    }
    row.push(String(total));
    rows.push(row);
  }

  return markdownTable(headers, rows);
}

async function readToolResults(toolOutputDir: string): Promise<string> {
  const lines: string[] = [];

  // Linters
  const linterDir = join(toolOutputDir, "linter-results");
  try {
    const files = await readdir(linterDir);
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const tool = file.replace(".json", "");
      try {
        const data = await readFile(join(linterDir, file), "utf-8");
        const parsed = JSON.parse(data);
        let count = 0;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (entry.messages && Array.isArray(entry.messages)) {
              count += entry.messages.length;
            }
          }
        }
        lines.push(`- **${tool}**: ${count} findings`);
      } catch {
        lines.push(`- **${tool}**: (output not parseable)`);
      }
    }
  } catch { /* no linter dir */ }

  // Type checkers
  const typecheckDir = join(toolOutputDir, "typecheck");
  try {
    const files = await readdir(typecheckDir);
    for (const file of files) {
      const tool = file.replace(/\.(txt|json)$/, "");
      try {
        const data = await readFile(join(typecheckDir, file), "utf-8");
        const count = data.split("\n").filter((l) => l.trim().length > 0).length;
        lines.push(`- **${tool}**: ${count} errors`);
      } catch {
        lines.push(`- **${tool}**: (output not readable)`);
      }
    }
  } catch { /* no typecheck dir */ }

  // Dep audits
  const depsDir = join(toolOutputDir, "deps");
  try {
    const files = await readdir(depsDir);
    for (const file of files) {
      const tool = file.replace(/\.(json|txt)$/, "");
      lines.push(`- **${tool}**: see raw output`);
    }
  } catch { /* no deps dir */ }

  return lines.length > 0 ? lines.join("\n") : "No tool results available.";
}

function formatSystemicPatterns(variants: VariantCandidates): string {
  const patterns = Object.entries(variants.systemic_patterns ?? {});
  if (patterns.length === 0) return "No systemic patterns detected.";

  const lines: string[] = [];
  for (const [rule, pattern] of patterns) {
    lines.push(
      `- **${rule}**: ${pattern.count} instances across ${pattern.directories.length} directories (${pattern.severity})`,
    );
  }
  return lines.join("\n");
}

function formatIssuesBySection(issues: EnrichedIssue[]): string {
  const grouped = new Map<string, Map<string, EnrichedIssue[]>>();
  for (const issue of issues) {
    const sevMap = grouped.get(issue.severity) ?? new Map<string, EnrichedIssue[]>();
    const catList = sevMap.get(issue.category) ?? [];
    catList.push(issue);
    sevMap.set(issue.category, catList);
    grouped.set(issue.severity, sevMap);
  }

  const sections: string[] = [];
  for (const sev of ["critical", "warning", "info"]) {
    const sevMap = grouped.get(sev);
    if (!sevMap) continue;

    sections.push(`### ${sev.charAt(0).toUpperCase() + sev.slice(1)} Findings\n`);
    for (const [cat, catIssues] of [...sevMap.entries()].sort()) {
      sections.push(`#### ${cat}\n`);
      for (const issue of catIssues.slice(0, 30)) {
        const loc = issue.line_range
          ? ` (${issue.file_path}:${Array.isArray(issue.line_range) ? issue.line_range.join("-") : issue.line_range})`
          : ` (${issue.file_path})`;
        sections.push(`- ${issue.description}${loc}`);
        if (issue.suggestion) {
          sections.push(`  > ${issue.suggestion}`);
        }
      }
      if (catIssues.length > 30) {
        sections.push(`- ... and ${catIssues.length - 30} more`);
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function assembleAuditReport(projectRoot: string): Promise<void> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const modulesDir = join(auditDir, "modules");
  const dataDir = join(auditDir, "data");
  const toolOutputDir = join(auditDir, "tool-output");
  const reportsDir = join(auditDir, "reports");

  await mkdir(reportsDir, { recursive: true });

  const modules = await readAllModules(modulesDir);
  const issues = flattenIssues(modules);

  // Sort: critical first, then warning, then info
  issues.sort((a, b) => {
    const sevDiff = severityOrder(a.severity) - severityOrder(b.severity);
    if (sevDiff !== 0) return sevDiff;
    return a.category.localeCompare(b.category);
  });

  const critical = issues.filter((i) => i.severity === "critical").length;
  const warning = issues.filter((i) => i.severity === "warning").length;
  const info = issues.filter((i) => i.severity === "info").length;

  const lines: string[] = [];

  // Header
  lines.push("# Audit Report\n");
  lines.push(
    `**Total findings:** ${issues.length} (${critical} critical, ${warning} warning, ${info} info)\n`,
  );

  // Summary table
  if (issues.length > 0) {
    lines.push("## Summary\n");
    lines.push(buildSummaryTable(issues));
    lines.push("");
  }

  // Tools that ran
  lines.push("## Tools That Ran\n");
  const toolResults = await readToolResults(toolOutputDir);
  lines.push(toolResults);
  lines.push("");

  // Systemic patterns
  const variants = await safeReadJson<VariantCandidates>(readFile, join(dataDir, "variant-analysis.json"));
  if (variants) {
    lines.push("## Systemic Patterns\n");
    lines.push(formatSystemicPatterns(variants));
    lines.push("");
  }

  // Findings by severity
  if (issues.length > 0) {
    lines.push("## Findings by Severity\n");
    lines.push(formatIssuesBySection(issues));
  }

  // Cross-module placeholder
  lines.push("<!-- CROSS_MODULE_PLACEHOLDER -->");
  lines.push(REPORT_FOOTER);

  await writeFile(join(reportsDir, "AUDIT_REPORT.md"), lines.join("\n"));
}

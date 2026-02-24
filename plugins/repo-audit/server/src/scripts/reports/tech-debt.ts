/**
 * Tech Debt Report Assembler.
 * Migrated from scripts/assemble-tech-debt.sh (184 LOC).
 *
 * Categorizes issues into Quick Wins, Strategic Improvements, and Major Refactors.
 * Includes linter violations and dependency bumps.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readAllModules } from "../../lib/modules.js";
import { markdownTable, safeReadJson, REPORT_FOOTER } from "./common.js";
import type { RiskScoresOutput, ModuleJson, ModuleIssue } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnrichedDebtIssue {
  file_path: string;
  module: string;
  severity: string;
  category: string;
  description: string;
  suggestion?: string;
  line_range?: string | [number, number];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenDebtIssues(
  modules: Array<{ data: ModuleJson }>,
): EnrichedDebtIssue[] {
  const issues: EnrichedDebtIssue[] = [];
  for (const { data } of modules) {
    for (const file of data.files ?? []) {
      for (const issue of file.issues ?? []) {
        issues.push({
          file_path: file.path,
          module: data.directory,
          severity: issue.severity ?? "warning",
          category: issue.category ?? "maintainability",
          description: issue.description,
          suggestion: issue.suggestion,
          line_range: issue.line_range,
        });
      }
    }
  }
  return issues;
}

async function countLinterFindings(toolOutputDir: string): Promise<Array<{ tool: string; count: number; fixCmd?: string }>> {
  const results: Array<{ tool: string; count: number; fixCmd?: string }> = [];
  const linterDir = join(toolOutputDir, "linter-results");

  const FIX_COMMANDS: Record<string, string> = {
    eslint: "npx eslint . --fix",
    ruff: "ruff check --fix .",
    biome: "npx biome check --apply .",
  };

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
        results.push({ tool, count, fixCmd: FIX_COMMANDS[tool] });
      } catch {
        results.push({ tool, count: 0 });
      }
    }
  } catch { /* no linter dir */ }

  return results;
}

async function countTypeErrors(toolOutputDir: string): Promise<number> {
  const typecheckDir = join(toolOutputDir, "typecheck");
  let total = 0;
  try {
    const files = await readdir(typecheckDir);
    for (const file of files) {
      try {
        const data = await readFile(join(typecheckDir, file), "utf-8");
        total += data.split("\n").filter((l) => l.trim().length > 0).length;
      } catch { /* skip */ }
    }
  } catch { /* no typecheck dir */ }
  return total;
}

async function countDepVulns(toolOutputDir: string): Promise<number> {
  const depsDir = join(toolOutputDir, "deps");
  let total = 0;
  try {
    const files = await readdir(depsDir);
    for (const file of files) {
      try {
        const data = await readFile(join(depsDir, file), "utf-8");
        if (file.endsWith(".json")) {
          const parsed = JSON.parse(data);
          if (parsed.metadata?.vulnerabilities) {
            const v = parsed.metadata.vulnerabilities;
            total += (v.critical ?? 0) + (v.high ?? 0) + (v.moderate ?? 0) + (v.low ?? 0);
          } else if (Array.isArray(parsed)) {
            total += parsed.length;
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* no deps dir */ }
  return total;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function assembleTechDebtReport(projectRoot: string): Promise<void> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const modulesDir = join(auditDir, "modules");
  const dataDir = join(auditDir, "data");
  const toolOutputDir = join(auditDir, "tool-output");
  const reportsDir = join(auditDir, "reports");

  await mkdir(reportsDir, { recursive: true });

  const modules = await readAllModules(modulesDir);
  const allIssues = flattenDebtIssues(modules);

  const lines: string[] = [];

  // Header
  lines.push("# Tech Debt Backlog\n");
  lines.push(`**Total issues found:** ${allIssues.length}\n`);

  // --- Quick Wins ---
  lines.push("## Quick Wins\n");
  lines.push("Low-effort fixes that can be addressed immediately.\n");

  // Linter violations
  const linters = await countLinterFindings(toolOutputDir);
  for (const linter of linters) {
    if (linter.count > 0) {
      lines.push(`### ${linter.tool} — ${linter.count} auto-fixable violations\n`);
      if (linter.fixCmd) {
        lines.push(`\`\`\`\n${linter.fixCmd}\n\`\`\`\n`);
      }
    }
  }

  // Type errors
  const typeErrors = await countTypeErrors(toolOutputDir);
  if (typeErrors > 0) {
    lines.push(`### Type Errors — ${typeErrors} errors\n`);
    lines.push("See `sdlc-audit/tool-output/typecheck/` for details.\n");
  }

  // Dep vulnerabilities
  const depVulns = await countDepVulns(toolOutputDir);
  if (depVulns > 0) {
    lines.push(`### Dependency Vulnerabilities — ${depVulns} findings\n`);
    lines.push("See `sdlc-audit/tool-output/deps/` for details.\n");
  }

  // Code-level quick fixes (info + low-effort warning issues)
  const quickFixes = allIssues.filter(
    (i) =>
      i.severity === "info" ||
      (i.severity === "warning" &&
        (i.category === "documentation" || i.category === "consistency")),
  );
  if (quickFixes.length > 0) {
    lines.push("### Code Fixes\n");
    for (const issue of quickFixes.slice(0, 20)) {
      const loc = issue.line_range
        ? `${issue.file_path}:${Array.isArray(issue.line_range) ? issue.line_range.join("-") : issue.line_range}`
        : issue.file_path;
      lines.push(`- ${issue.description} (\`${loc}\`)`);
    }
    if (quickFixes.length > 20) {
      lines.push(`- ... and ${quickFixes.length - 20} more`);
    }
    lines.push("");
  }

  // --- Strategic Improvements ---
  lines.push("## Strategic Improvements\n");
  lines.push("Medium-effort changes that improve maintainability.\n");

  const strategicIssues = allIssues.filter(
    (i) =>
      i.severity === "warning" &&
      (i.category === "maintainability" ||
        i.category === "performance" ||
        i.category === "error_handling"),
  );
  if (strategicIssues.length > 0) {
    for (const issue of strategicIssues.slice(0, 20)) {
      lines.push(`- ${issue.description} (\`${issue.file_path}\`)`);
      if (issue.suggestion) {
        lines.push(`  > ${issue.suggestion}`);
      }
    }
    if (strategicIssues.length > 20) {
      lines.push(`- ... and ${strategicIssues.length - 20} more`);
    }
  }
  lines.push("");
  lines.push("<!-- DRY_VIOLATIONS_PLACEHOLDER -->\n");

  // --- Major Refactors ---
  lines.push("## Major Refactors\n");
  lines.push("High-effort changes addressing critical issues.\n");

  const majorIssues = allIssues.filter((i) => i.severity === "critical");
  if (majorIssues.length > 0) {
    for (const issue of majorIssues.slice(0, 20)) {
      lines.push(`- **${issue.category}**: ${issue.description} (\`${issue.file_path}\`)`);
      if (issue.suggestion) {
        lines.push(`  > ${issue.suggestion}`);
      }
    }
    if (majorIssues.length > 20) {
      lines.push(`- ... and ${majorIssues.length - 20} more`);
    }
  }
  lines.push("");
  lines.push("<!-- ARCHITECTURE_ISSUES_PLACEHOLDER -->\n");

  // Risk-weighted priorities
  const riskScores = await safeReadJson<RiskScoresOutput>(readFile, join(dataDir, "risk-scores.json"));
  if (riskScores && riskScores.scores.length > 0) {
    lines.push("## Risk-Weighted Priorities\n");
    const top10 = riskScores.scores.slice(0, 10);
    const rows = top10.map((s) => [
      s.module,
      s.risk_score.toFixed(1),
      String(s.issue_count),
      s.test_coverage,
      String(s.total_lines),
    ]);
    lines.push(markdownTable(
      ["Module", "Risk Score", "Issues", "Coverage", "Lines"],
      rows,
    ));
    lines.push("");
  }

  lines.push(REPORT_FOOTER);

  await writeFile(join(reportsDir, "TECH_DEBT.md"), lines.join("\n"));
}

/**
 * Reports are exports, not the source of truth. Everything here is a query
 * against audit.db and can be regenerated at any time.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/db.js";
import { severityRank } from "../findings/types.js";
import { computeRisk } from "../plan/risk.js";

export interface ExportResult {
  reports: string[];
  openFindings: number;
  tasks: number;
  bySeverity: Record<string, number>;
}

interface FindingRow {
  id: string;
  rule_id: string;
  category: string;
  severity: string;
  confidence: string;
  source: string;
  path: string | null;
  line_start: number | null;
  title: string;
  description: string;
  suggestion: string | null;
  status: string;
  occurrences: number;
}

interface Task {
  id: string;
  title: string;
  severity: string;
  confidence: string;
  category: string;
  source: string;
  files: string[];
  description: string;
  suggestion?: string;
  systemic: boolean;
  effort: "small" | "medium" | "large";
}

const SEVERITY_ORDER = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

function effortFor(fileCount: number, severity: string): Task["effort"] {
  if (fileCount > 5) return "large";
  if (fileCount > 1 || severity === "critical") return "medium";
  return "small";
}

/** Group open findings into tasks, collapsing a rule that spans many files. */
export function buildTasks(findings: FindingRow[]): Task[] {
  const byRule = new Map<string, FindingRow[]>();
  for (const finding of findings) {
    const list = byRule.get(finding.rule_id);
    if (list) list.push(finding);
    else byRule.set(finding.rule_id, [finding]);
  }

  const tasks: Task[] = [];
  for (const [ruleId, group] of byRule) {
    const files = [
      ...new Set(
        group.map((f) => (f.line_start ? `${f.path}:${f.line_start}` : (f.path ?? ""))),
      ),
    ].filter(Boolean);
    const systemic = group.length >= 3;
    const worst = group.reduce((a, b) => (severityRank(a.severity) <= severityRank(b.severity) ? a : b));

    if (systemic) {
      tasks.push({
        id: worst.id,
        title: `${worst.title} (${group.length} occurrences)`,
        severity: worst.severity,
        confidence: worst.confidence,
        category: worst.category,
        source: worst.source,
        files,
        description: `${ruleId} appears ${group.length} times. ${worst.description}`,
        suggestion: worst.suggestion ?? undefined,
        systemic: true,
        effort: effortFor(files.length, worst.severity),
      });
      continue;
    }

    for (const finding of group) {
      tasks.push({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        confidence: finding.confidence,
        category: finding.category,
        source: finding.source,
        files: finding.line_start
          ? [`${finding.path}:${finding.line_start}`]
          : finding.path
            ? [finding.path]
            : [],
        description: finding.description,
        suggestion: finding.suggestion ?? undefined,
        systemic: false,
        effort: effortFor(1, finding.severity),
      });
    }
  }

  return tasks.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.files.length - a.files.length,
  );
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_None._";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function auditReport(db: Db, tasks: Task[]): string {
  const bySeverity = db.all<{ severity: string; n: number }>(
    `SELECT severity, COUNT(*) AS n FROM findings WHERE status IN ('open','regressed')
      GROUP BY severity ORDER BY ${SEVERITY_ORDER}`,
  );
  const byCategory = db.all<{ category: string; n: number }>(
    `SELECT category, COUNT(*) AS n FROM findings WHERE status IN ('open','regressed')
      GROUP BY category ORDER BY n DESC`,
  );
  const tools = db.all<{ tool: string; status: string; detail: string }>(
    `SELECT tool, status, detail FROM tool_runs
      WHERE run_id = (SELECT MAX(run_id) FROM tool_runs) ORDER BY tool`,
  );
  const fixed = db.count("SELECT COUNT(*) AS n FROM findings WHERE status = 'fixed'");
  const regressed = db.count("SELECT COUNT(*) AS n FROM findings WHERE status = 'regressed'");

  const lines: string[] = ["# Audit", ""];

  lines.push(
    table(
      ["Severity", "Open"],
      bySeverity.map((row) => [row.severity, String(row.n)]),
    ),
    "",
    `Fixed since first run: ${fixed}. Regressed: ${regressed}.`,
    "",
    "## By category",
    "",
    table(["Category", "Open"], byCategory.map((row) => [row.category, String(row.n)])),
    "",
    "## Tools",
    "",
    table(
      ["Tool", "Status", "Detail"],
      tools.map((row) => [row.tool, row.status, row.detail ?? ""]),
    ),
    "",
    "## Findings",
    "",
  );

  for (const severity of ["critical", "high", "medium", "low"]) {
    const group = tasks.filter((task) => task.severity === severity);
    if (group.length === 0) continue;
    lines.push(`### ${severity} (${group.length})`, "");
    for (const task of group.slice(0, 50)) {
      lines.push(`- **${task.title}**`);
      lines.push(`  ${task.files.slice(0, 6).join(", ")}${task.files.length > 6 ? ", …" : ""}`);
      if (task.suggestion) lines.push(`  > ${task.suggestion}`);
    }
    if (group.length > 50) lines.push(`- … and ${group.length - 50} more (see TASKS.json)`);
    lines.push("");
  }

  return lines.join("\n");
}

function mapReport(db: Db): string {
  const languages = db.all<{ lang: string; files: number; loc: number }>(
    `SELECT lang, COUNT(*) AS files, SUM(loc) AS loc FROM files
      WHERE present = 1 GROUP BY lang ORDER BY loc DESC`,
  );
  const hubs = db.all<{ path: string; fan_in: number; loc: number }>(
    `SELECT f.path, f.loc, (SELECT COUNT(*) FROM edges e WHERE e.dst_path = f.path) AS fan_in
       FROM files f WHERE f.present = 1 AND f.is_test = 0
      ORDER BY fan_in DESC LIMIT 15`,
  );
  const externals = db.all<{ package: string; used_by: number }>(
    `SELECT external AS package, COUNT(DISTINCT src_path) AS used_by FROM edges
      WHERE external IS NOT NULL GROUP BY external ORDER BY used_by DESC LIMIT 20`,
  );
  const risks = computeRisk(db).slice(0, 15);
  const untested = db.count(
    `SELECT COUNT(*) AS n FROM files f WHERE f.present = 1 AND f.is_test = 0 AND f.parsed = 1
       AND NOT EXISTS (SELECT 1 FROM edges e JOIN files t ON t.path = e.src_path
                        WHERE e.dst_path = f.path AND t.is_test = 1)`,
  );

  return [
    "# Project map",
    "",
    table(
      ["Language", "Files", "Lines"],
      languages.map((row) => [row.lang, String(row.files), String(row.loc ?? 0)]),
    ),
    "",
    `Source files with no importing test: **${untested}**.`,
    "",
    "## Most depended-on files",
    "",
    table(
      ["File", "Importers", "Lines"],
      hubs.filter((row) => row.fan_in > 0).map((row) => [row.path, String(row.fan_in), String(row.loc)]),
    ),
    "",
    "## Highest risk",
    "",
    table(
      ["File", "Risk", "Importers", "Commits", "Open findings", "Tested"],
      risks.map((row) => [
        row.path,
        String(row.risk),
        String(row.fanIn),
        String(row.churn),
        String(row.findings),
        row.covered ? "yes" : "no",
      ]),
    ),
    "",
    "## External packages",
    "",
    table(
      ["Package", "Used by"],
      externals.map((row) => [row.package, String(row.used_by)]),
    ),
    "",
  ].join("\n");
}

export async function exportReports(
  db: Db,
  projectRoot: string,
): Promise<ExportResult> {
  const auditDir = join(projectRoot, "sdlc-audit");
  const reportsDir = join(auditDir, "reports");
  await mkdir(reportsDir, { recursive: true });

  const findings = db.all<FindingRow>(
    `SELECT id, rule_id, category, severity, confidence, source, path, line_start,
            title, description, suggestion, status, occurrences
       FROM findings WHERE status IN ('open','regressed')
      ORDER BY ${SEVERITY_ORDER}, path`,
  );
  const tasks = buildTasks(findings);

  await writeFile(join(reportsDir, "AUDIT.md"), auditReport(db, tasks));
  await writeFile(join(reportsDir, "MAP.md"), mapReport(db));
  await writeFile(
    join(auditDir, "TASKS.json"),
    JSON.stringify(
      {
        version: "2.0.0",
        generated: new Date().toISOString(),
        summary: {
          total: tasks.length,
          bySeverity: tasks.reduce<Record<string, number>>((acc, task) => {
            acc[task.severity] = (acc[task.severity] ?? 0) + 1;
            return acc;
          }, {}),
        },
        tasks,
      },
      null,
      2,
    ),
  );

  const bySeverity: Record<string, number> = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }

  return {
    reports: ["reports/AUDIT.md", "reports/MAP.md", "TASKS.json"],
    openFindings: findings.length,
    tasks: tasks.length,
    bySeverity,
  };
}

/**
 * Risk ranking and work-unit planning.
 *
 * Risk is computed before analysis so token spend follows blast radius and
 * churn instead of being spread evenly over directories.
 */

import type { Db } from "../db/db.js";

export interface FileRisk {
  path: string;
  lang: string;
  loc: number;
  bytes: number;
  fanIn: number;
  churn: number;
  findings: number;
  weighted: number;
  covered: boolean;
  risk: number;
}

export interface WorkUnit {
  id: string;
  paths: string[];
  languages: string[];
  risk: number;
  estimatedTokens: number;
  reason: string;
}

const SEVERITY_WEIGHT = [4, 3, 2, 1];

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.log1p(value) / Math.log1p(max);
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

export function computeRisk(db: Db): FileRisk[] {
  const rows = db.all<{
    path: string;
    lang: string;
    loc: number;
    bytes: number;
    churn: number;
    fan_in: number;
    findings: number;
    weighted: number;
    covered: number;
  }>(`
    SELECT f.path, f.lang, f.loc, f.bytes, f.churn,
           (SELECT COUNT(*) FROM edges e WHERE e.dst_path = f.path) AS fan_in,
           (SELECT COUNT(*) FROM findings x
             WHERE x.path = f.path AND x.status IN ('open','regressed')) AS findings,
           (SELECT COALESCE(SUM(CASE x.severity
                     WHEN 'critical' THEN ${SEVERITY_WEIGHT[0]}
                     WHEN 'high' THEN ${SEVERITY_WEIGHT[1]}
                     WHEN 'medium' THEN ${SEVERITY_WEIGHT[2]}
                     ELSE ${SEVERITY_WEIGHT[3]} END), 0)
              FROM findings x WHERE x.path = f.path AND x.status IN ('open','regressed')) AS weighted,
           (SELECT COUNT(*) FROM edges e
             JOIN files tf ON tf.path = e.src_path
            WHERE e.dst_path = f.path AND tf.is_test = 1) AS covered
      FROM files f
     WHERE f.present = 1 AND f.parsed = 1 AND f.is_test = 0
  `);

  // reduce, not Math.max(...spread): one argument per file overflows the
  // call stack somewhere past 100k files, which is exactly the monorepo size
  // where risk ranking matters most.
  const maxOf = (pick: (r: (typeof rows)[number]) => number): number =>
    rows.reduce((max, row) => Math.max(max, pick(row)), 1);
  const maxFanIn = maxOf((r) => r.fan_in);
  const maxChurn = maxOf((r) => r.churn);
  const maxLoc = maxOf((r) => r.loc);
  const maxWeighted = maxOf((r) => r.weighted);

  return rows
    .map((row) => {
      const covered = row.covered > 0;
      const risk =
        100 *
        (0.3 * normalize(row.fan_in, maxFanIn) +
          0.2 * normalize(row.churn, maxChurn) +
          0.25 * normalize(row.weighted, maxWeighted) +
          0.15 * (covered ? 0 : 1) +
          0.1 * normalize(row.loc, maxLoc));

      return {
        path: row.path,
        lang: row.lang,
        loc: row.loc,
        bytes: row.bytes,
        fanIn: row.fan_in,
        churn: row.churn,
        findings: row.findings,
        weighted: row.weighted,
        covered,
        risk: Math.round(risk * 10) / 10,
      };
    })
    .sort((a, b) => b.risk - a.risk);
}

function describe(files: FileRisk[]): string {
  const top = files[0];
  const parts: string[] = [];
  if (top.fanIn > 0) parts.push(`${top.fanIn} importers`);
  if (top.churn > 0) parts.push(`${top.churn} recent commits`);
  if (top.findings > 0) parts.push(`${top.findings} open findings`);
  if (!files.some((file) => file.covered)) parts.push("no test imports");
  return parts.length > 0 ? parts.join(", ") : "baseline coverage";
}

/**
 * Group files into review units, largest risk first.
 * Units stay inside a directory so an agent sees cohesive code.
 */
export function planUnits(
  db: Db,
  options: { tokenBudget?: number; maxUnits?: number } = {},
): WorkUnit[] {
  const tokenBudget = options.tokenBudget ?? 60_000;
  const maxUnits = options.maxUnits ?? 20;
  // Source may take at most half the budget; the rest is graph + findings + rules.
  const sourceBudget = Math.floor(tokenBudget * 0.5);

  const byDir = new Map<string, FileRisk[]>();
  for (const file of computeRisk(db)) {
    const dir = dirOf(file.path);
    const list = byDir.get(dir);
    if (list) list.push(file);
    else byDir.set(dir, [file]);
  }

  const units: WorkUnit[] = [];
  for (const files of byDir.values()) {
    let batch: FileRisk[] = [];
    let tokens = 0;

    const flush = (): void => {
      if (batch.length === 0) return;
      units.push({
        id: "",
        paths: batch.map((file) => file.path),
        languages: [...new Set(batch.map((file) => file.lang))],
        risk: Math.round((batch.reduce((sum, f) => sum + f.risk, 0) / batch.length) * 10) / 10,
        estimatedTokens: tokens,
        reason: describe(batch),
      });
      batch = [];
      tokens = 0;
    };

    for (const file of files) {
      const fileTokens = Math.ceil(file.bytes / 4);
      if (batch.length > 0 && tokens + fileTokens > sourceBudget) flush();
      batch.push(file);
      tokens += fileTokens;
    }
    flush();
  }

  return units
    .sort((a, b) => b.risk - a.risk)
    .slice(0, maxUnits)
    .map((unit, index) => ({ ...unit, id: `unit-${String(index + 1).padStart(2, "0")}` }));
}

export function savePlan(db: Db, units: WorkUnit[]): void {
  db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('work_plan', ?)", [
    JSON.stringify(units),
  ]);
}

export function loadPlan(db: Db): WorkUnit[] {
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'work_plan'");
  if (!row) return [];
  try {
    return JSON.parse(row.value) as WorkUnit[];
  } catch {
    return [];
  }
}

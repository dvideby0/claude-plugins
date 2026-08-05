/**
 * Read models for the UI.
 *
 * These are queries against a workspace's store, shaped for a screen rather
 * than for an agent. They live apart from the MCP tools because the two have
 * genuinely different consumers: an agent wants facts it can reason over, a
 * person wants a picture ranked by what matters.
 */

import { componentOf } from "../graph/map.js";
import type { Db } from "../db/db.js";
import { listMemories, type Memory } from "../memory/store.js";

const SOURCE_LANGS = "('typescript','javascript','python')";
const OPEN = "('open','regressed')";

export interface GraphNode {
  path: string;
  /** Last path segment — what the graph is labelled with. */
  label: string;
  lang: string;
  loc: number;
  isTest: boolean;
  /** How many files import this one. Blast radius. */
  importers: number;
  imports: number;
  findings: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Total source files, so the UI can say what it is not showing. */
  totalFiles: number;
  truncated: boolean;
}

/**
 * The most connected slice of the import graph.
 *
 * A whole repository is unreadable as a node-link diagram past a few hundred
 * files, so this returns the files with the largest blast radius and only the
 * edges among them — the part a person can actually act on.
 */
export function graphView(db: Db, limit = 120): GraphView {
  const totalFiles = db.count(
    `SELECT COUNT(*) AS n FROM files WHERE present = 1 AND lang IN ${SOURCE_LANGS}`,
  );

  const nodes = db.all<{
    path: string;
    lang: string;
    loc: number;
    is_test: number;
    importers: number;
    imports: number;
    findings: number;
  }>(
    `SELECT f.path, f.lang, f.loc, f.is_test,
            (SELECT COUNT(*) FROM edges e WHERE e.dst_path = f.path) AS importers,
            (SELECT COUNT(*) FROM edges e WHERE e.src_path = f.path AND e.dst_path IS NOT NULL) AS imports,
            (SELECT COUNT(*) FROM findings fi WHERE fi.path = f.path AND fi.status IN ${OPEN}) AS findings
     FROM files f
     WHERE f.present = 1 AND f.lang IN ${SOURCE_LANGS}
     ORDER BY importers DESC, imports DESC, f.loc DESC
     LIMIT ?`,
    [limit],
  );

  const included = new Set(nodes.map((node) => node.path));
  const edges = db
    .all<{ src_path: string; dst_path: string }>(
      `SELECT src_path, dst_path FROM edges WHERE dst_path IS NOT NULL`,
    )
    .filter((edge) => included.has(edge.src_path) && included.has(edge.dst_path))
    .map((edge) => ({ from: edge.src_path, to: edge.dst_path }));

  return {
    nodes: nodes.map((node) => ({
      path: node.path,
      label: node.path.split("/").pop() ?? node.path,
      lang: node.lang,
      loc: node.loc,
      isTest: node.is_test === 1,
      importers: node.importers,
      imports: node.imports,
      findings: node.findings,
    })),
    edges,
    totalFiles,
    truncated: totalFiles > nodes.length,
  };
}

export interface FindingRow {
  id: string;
  ruleId: string;
  category: string;
  severity: string;
  confidence: string;
  source: string;
  status: string;
  path: string | null;
  lineStart: number | null;
  title: string;
  description: string;
  suggestion: string | null;
  occurrences: number;
}

export interface FindingsView {
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  /** Every lifecycle state, so the UI can show what got fixed, not just what is open. */
  byStatus: Record<string, number>;
  rows: FindingRow[];
  total: number;
  status: string;
}

const SEVERITY_ORDER = `CASE severity
  WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
  WHEN 'low' THEN 3 ELSE 4 END`;

/**
 * @param status "open" (open + regressed), a single lifecycle state, or "all".
 */
export function findingsView(db: Db, limit = 200, status = "open"): FindingsView {
  const filter =
    status === "all"
      ? "1 = 1"
      : status === "open"
        ? `status IN ${OPEN}`
        : "status = ?";
  const params: Array<string | number> = status === "all" || status === "open" ? [] : [status];

  const rows = db.all<{
    id: string;
    rule_id: string;
    category: string;
    severity: string;
    confidence: string;
    source: string;
    status: string;
    path: string | null;
    line_start: number | null;
    title: string;
    description: string;
    suggestion: string | null;
    occurrences: number;
  }>(
    `SELECT id, rule_id, category, severity, confidence, source, status, path, line_start,
            title, description, suggestion, occurrences
     FROM findings WHERE ${filter}
     ORDER BY ${SEVERITY_ORDER}, path LIMIT ?`,
    [...params, limit],
  );

  const tally = (sql: string): Record<string, number> =>
    Object.fromEntries(
      db
        .all<{ key: string; n: number }>(sql)
        .map((row) => [row.key, row.n]),
    );

  return {
    bySeverity: tally(
      `SELECT severity AS key, COUNT(*) AS n FROM findings WHERE status IN ${OPEN} GROUP BY severity`,
    ),
    byCategory: tally(
      `SELECT category AS key, COUNT(*) AS n FROM findings WHERE status IN ${OPEN} GROUP BY category`,
    ),
    byStatus: tally("SELECT status AS key, COUNT(*) AS n FROM findings GROUP BY status"),
    rows: rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      category: row.category,
      severity: row.severity,
      confidence: row.confidence,
      source: row.source,
      status: row.status,
      path: row.path,
      lineStart: row.line_start,
      title: row.title,
      description: row.description,
      suggestion: row.suggestion,
      occurrences: row.occurrences,
    })),
    total: db.count(`SELECT COUNT(*) AS n FROM findings WHERE ${filter}`, params),
    status,
  };
}

export interface MemoriesView {
  byKind: Record<string, number>;
  memories: Memory[];
  total: number;
}

export function memoriesView(db: Db, limit = 200): MemoriesView {
  const memories = listMemories(db, undefined, limit);
  return {
    byKind: Object.fromEntries(
      db
        .all<{ kind: string; n: number }>(
          "SELECT kind, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY kind ORDER BY n DESC",
        )
        .map((row) => [row.kind, row.n]),
    ),
    memories,
    total: db.count("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'"),
  };
}

export interface FileView {
  path: string;
  lang: string;
  loc: number;
  churn: number;
  isTest: boolean;
  importers: string[];
  imports: string[];
  externals: string[];
  symbols: Array<{ kind: string; name: string; startLine: number; exported: boolean }>;
  findings: FindingRow[];
  /** Which drawn component this file belongs to, if anyone has drawn one. */
  component: { id: string; name: string } | null;
}

export function fileView(db: Db, path: string): FileView | null {
  const file = db.get<{
    path: string;
    lang: string;
    loc: number;
    churn: number;
    is_test: number;
  }>("SELECT path, lang, loc, churn, is_test FROM files WHERE path = ? AND present = 1", [path]);
  if (!file) return null;

  const column = <T extends string>(sql: string, params: Array<string | number>): T[] =>
    db.all<Record<string, T>>(sql, params).map((row) => Object.values(row)[0] as T);

  return {
    component: componentOf(db, file.path),
    path: file.path,
    lang: file.lang,
    loc: file.loc,
    churn: file.churn,
    isTest: file.is_test === 1,
    importers: column<string>(
      "SELECT src_path FROM edges WHERE dst_path = ? ORDER BY src_path LIMIT 100",
      [path],
    ),
    imports: column<string>(
      "SELECT dst_path FROM edges WHERE src_path = ? AND dst_path IS NOT NULL ORDER BY dst_path LIMIT 100",
      [path],
    ),
    externals: column<string>(
      "SELECT DISTINCT external FROM edges WHERE src_path = ? AND external IS NOT NULL ORDER BY external LIMIT 100",
      [path],
    ),
    symbols: db
      .all<{ kind: string; name: string; start_line: number; exported: number }>(
        "SELECT kind, name, start_line, exported FROM symbols WHERE path = ? ORDER BY start_line LIMIT 200",
        [path],
      )
      .map((symbol) => ({
        kind: symbol.kind,
        name: symbol.name,
        startLine: symbol.start_line,
        exported: symbol.exported === 1,
      })),
    findings: db
      .all<{
        id: string;
        rule_id: string;
        category: string;
        severity: string;
        confidence: string;
        source: string;
        status: string;
        line_start: number | null;
        title: string;
        description: string;
        suggestion: string | null;
        occurrences: number;
      }>(
        `SELECT id, rule_id, category, severity, confidence, source, status, line_start,
                title, description, suggestion, occurrences
         FROM findings WHERE path = ? AND status IN ${OPEN} ORDER BY ${SEVERITY_ORDER}`,
        [path],
      )
      .map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        category: row.category,
        severity: row.severity,
        confidence: row.confidence,
        source: row.source,
        status: row.status,
        path,
        lineStart: row.line_start,
        title: row.title,
        description: row.description,
        suggestion: row.suggestion,
        occurrences: row.occurrences,
      })),
  };
}

export interface OverviewView {
  languages: Record<string, number>;
  /** Files nothing imports — entry points, dead code, or unreachable. */
  orphans: number;
  externals: Array<{ name: string; used: number }>;
  hotspots: Array<{ path: string; importers: number; loc: number; findings: number }>;
  lastRun: { kind: string; startedAt: string; gitSha: string | null } | null;
  tools: Array<{ tool: string; status: string; findings: number; detail: string | null }>;
}

export function overviewView(db: Db): OverviewView {
  const lastRunId = db.get<{ id: number }>("SELECT id FROM runs ORDER BY id DESC LIMIT 1")?.id;

  return {
    languages: Object.fromEntries(
      db
        .all<{ lang: string; n: number }>(
          "SELECT lang, COUNT(*) AS n FROM files WHERE present = 1 GROUP BY lang ORDER BY n DESC",
        )
        .map((row) => [row.lang, row.n]),
    ),
    orphans: db.count(
      `SELECT COUNT(*) AS n FROM files f
       WHERE f.present = 1 AND f.lang IN ${SOURCE_LANGS} AND f.is_test = 0
         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_path = f.path)`,
    ),
    externals: db.all<{ name: string; used: number }>(
      `SELECT external AS name, COUNT(DISTINCT src_path) AS used
       FROM edges WHERE external IS NOT NULL
       GROUP BY external ORDER BY used DESC LIMIT 15`,
    ),
    hotspots: db.all<{ path: string; importers: number; loc: number; findings: number }>(
      `SELECT f.path, f.loc,
              (SELECT COUNT(*) FROM edges e WHERE e.dst_path = f.path) AS importers,
              (SELECT COUNT(*) FROM findings fi WHERE fi.path = f.path AND fi.status IN ${OPEN}) AS findings
       FROM files f WHERE f.present = 1 AND f.lang IN ${SOURCE_LANGS}
       ORDER BY importers DESC, f.loc DESC LIMIT 10`,
    ),
    lastRun: (() => {
      const run = db.get<{ kind: string; started_at: string; git_sha: string | null }>(
        "SELECT kind, started_at, git_sha FROM runs ORDER BY id DESC LIMIT 1",
      );
      return run ? { kind: run.kind, startedAt: run.started_at, gitSha: run.git_sha } : null;
    })(),
    tools:
      lastRunId === undefined
        ? []
        : db.all<{ tool: string; status: string; findings: number; detail: string | null }>(
            "SELECT tool, status, findings, detail FROM tool_runs WHERE run_id = ? ORDER BY tool",
            [lastRunId],
          ),
  };
}

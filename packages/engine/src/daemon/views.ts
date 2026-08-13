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
import { fileEvidenceBasis, type EvidenceBasis } from "../lib/freshness.js";
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
  lineEnd: number | null;
  /** Indexed file revision that produced this finding's evidence range. */
  contentSha: string | null;
  title: string;
  description: string;
  suggestion: string | null;
  occurrences: number;
  /**
   * For a retired finding, the rule that stopped its file being indexed.
   * Null when the finding is not retired, or when the bounded record of
   * excluded paths does not list this one.
   */
  excluded: { path: string; directory: boolean; reason: string; detail: string } | null;
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
    line_end: number | null;
    content_sha: string | null;
    title: string;
    description: string;
    suggestion: string | null;
    occurrences: number;
  }>(
    `SELECT id, rule_id, category, severity, confidence, source, status, path, line_start, line_end, content_sha,
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
      lineEnd: row.line_end,
      contentSha: row.content_sha,
      title: row.title,
      description: row.description,
      suggestion: row.suggestion,
      occurrences: row.occurrences,
      // Only a retired row needs this, and only it pays for the lookup. The
      // reason lives in `excluded_paths` rather than on the finding, so the
      // two can never disagree about why a path left. Null is honest: the
      // recorded sample is bounded, so the rule is sometimes not listed.
      excluded: row.status === "retired" && row.path ? exclusionForPath(db, row.path) : null,
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

export interface FileSymbolView {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface FileView {
  /** False when a finding points at readable source excluded from the index. */
  indexed: boolean;
  path: string;
  lang: string;
  loc: number;
  contentSha: string;
  churn: number;
  isTest: boolean;
  importers: string[];
  imports: string[];
  externals: string[];
  symbols: FileSymbolView[];
  symbolsTotal: number;
  /** Exact-name declarations requested for authored navigation. */
  symbolMatches: FileSymbolView[];
  symbolMatchTotal: number;
  findings: FindingRow[];
  /** Which drawn component this file belongs to, if anyone has drawn one. */
  component: { id: string; name: string } | null;
  /** How this file's facts were established — read, or trusted unchanged. */
  evidence: EvidenceBasis;
}

function findingsForPath(db: Db, path: string): FindingRow[] {
  return db
    .all<{
      id: string;
      rule_id: string;
      category: string;
      severity: string;
      confidence: string;
      source: string;
      status: string;
      line_start: number | null;
      line_end: number | null;
      content_sha: string | null;
      title: string;
      description: string;
      suggestion: string | null;
      occurrences: number;
    }>(
      `SELECT id, rule_id, category, severity, confidence, source, status, line_start, line_end, content_sha,
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
      lineEnd: row.line_end,
      contentSha: row.content_sha,
      title: row.title,
      description: row.description,
      suggestion: row.suggestion,
      occurrences: row.occurrences,
      // This view is filtered to open and regressed findings, so none of them
      // can be retired and none of them has a rule to name.
      excluded: null,
    }));
}

const FILE_SYMBOL_LIMIT = 200;

function symbolsForPath(db: Db, path: string, name?: string): FileSymbolView[] {
  const where = name === undefined ? "path = ?" : "path = ? AND name = ?";
  return db
    .all<{
      kind: string;
      name: string;
      start_line: number;
      end_line: number;
      exported: number;
    }>(
      `SELECT kind, name, start_line, end_line, exported
       FROM symbols WHERE ${where} ORDER BY start_line, start_column LIMIT ?`,
      name === undefined ? [path, FILE_SYMBOL_LIMIT] : [path, name, FILE_SYMBOL_LIMIT],
    )
    .map((symbol) => ({
      kind: symbol.kind,
      name: symbol.name,
      startLine: symbol.start_line,
      endLine: symbol.end_line,
      exported: symbol.exported === 1,
    }));
}

export function fileView(db: Db, path: string, requestedSymbol?: string): FileView | null {
  const file = db.get<{
    path: string;
    lang: string;
    loc: number;
    content_sha: string;
    churn: number;
    is_test: number;
  }>("SELECT path, lang, loc, content_sha, churn, is_test FROM files WHERE path = ? AND present = 1", [path]);
  if (!file) return null;

  const column = <T extends string>(sql: string, params: Array<string | number>): T[] =>
    db.all<Record<string, T>>(sql, params).map((row) => Object.values(row)[0] as T);

  return {
    indexed: true,
    component: componentOf(db, file.path),
    path: file.path,
    lang: file.lang,
    loc: file.loc,
    contentSha: file.content_sha,
    churn: file.churn,
    isTest: file.is_test === 1,
    // Beside the exclusion reason, which answers the neighbouring question of
    // why a path is absent. Together they explain the whole boundary: what was
    // left out and why, and what was kept and on what evidence.
    evidence: fileEvidenceBasis(db, file.path),
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
    symbols: symbolsForPath(db, path),
    symbolsTotal: db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = ?", [path]),
    symbolMatches: requestedSymbol ? symbolsForPath(db, path, requestedSymbol) : [],
    symbolMatchTotal: requestedSymbol
      ? db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = ? AND name = ?", [
          path,
          requestedSymbol,
        ])
      : 0,
    findings: findingsForPath(db, path),
  };
}

/**
 * Build the same drawer model for readable source that is absent from the
 * deterministic inventory, but only when an analyzer has already recorded a
 * finding for that exact path. This preserves the index boundary and avoids
 * turning the desktop endpoint into an arbitrary hidden-file reader.
 */
export function unindexedFindingFileView(
  db: Db,
  path: string,
  source: { lang: string; loc: number; contentSha: string },
): FileView | null {
  const hasFinding = db.get<{ present: number }>(
    "SELECT 1 AS present FROM findings WHERE path = ? LIMIT 1",
    [path],
  );
  if (!hasFinding) return null;

  return {
    indexed: false,
    path,
    lang: source.lang,
    loc: source.loc,
    contentSha: source.contentSha,
    churn: 0,
    isTest: false,
    // This file is not in the inventory at all, so no scan established
    // anything about it. The bytes here came from a finding's own record.
    evidence: fileEvidenceBasis(db, path),
    importers: [],
    imports: [],
    externals: [],
    symbols: [],
    symbolsTotal: 0,
    symbolMatches: [],
    symbolMatchTotal: 0,
    findings: findingsForPath(db, path),
    component: null,
  };
}

/**
 * What the repository inventory left out, and why.
 *
 * Map coverage is only a trustworthy number when the denominator is
 * explainable. Packaged output once entered the map as an unexplained file
 * precisely because nothing recorded this.
 */
export interface InputBoundaryView {
  /** Every decision to exclude a path, including reasons not listed per path. */
  excludedTotal: number;
  byReason: Array<{ reason: string; paths: number; recorded: number }>;
  samples: Array<{ path: string; directory: boolean; reason: string; detail: string }>;
  /** True when more decisions were made than are listed in `samples`. */
  truncated: boolean;
}

export interface OverviewView {
  languages: Record<string, number>;
  /** Files nothing imports — entry points, dead code, or unreachable. */
  orphans: number;
  externals: Array<{ name: string; used: number }>;
  hotspots: Array<{ path: string; importers: number; loc: number; findings: number }>;
  lastRun: { kind: string; startedAt: string; gitSha: string | null } | null;
  tools: Array<{ tool: string; status: string; findings: number; detail: string | null }>;
  inputBoundary: InputBoundaryView;
}

const OVERVIEW_EXCLUSION_SAMPLES = 40;

export function inputBoundaryView(db: Db): InputBoundaryView {
  const byReason = db.all<{ reason: string; paths: number; recorded: number }>(
    `SELECT reason, paths, recorded FROM exclusion_summary
      WHERE reason NOT IN ('source', 'noise')
      ORDER BY paths DESC, reason`,
  );
  const samples = db.all<{ path: string; directory: number; reason: string; detail: string }>(
    `SELECT path, directory, reason, detail FROM excluded_paths
      ORDER BY directory DESC, path
      LIMIT ?`,
    [OVERVIEW_EXCLUSION_SAMPLES],
  );
  const recordedTotal = byReason.reduce((total, row) => total + row.recorded, 0);
  return {
    excludedTotal: byReason.reduce((total, row) => total + row.paths, 0),
    byReason,
    samples: samples.map((row) => ({
      path: row.path,
      directory: row.directory === 1,
      reason: row.reason,
      detail: row.detail,
    })),
    truncated: samples.length < recordedTotal,
  };
}

/**
 * Why one path is not in the index.
 *
 * A pruned directory answers for everything beneath it, so the longest
 * matching prefix is the decision that actually applied.
 */
export function exclusionForPath(
  db: Db,
  path: string,
): { path: string; directory: boolean; reason: string; detail: string } | null {
  const row = db.get<{ path: string; directory: number; reason: string; detail: string }>(
    // A recorded directory answers for everything beneath it, matched by
    // prefix rather than LIKE: `node_modules` and `__pycache__` contain `_`,
    // which LIKE reads as a wildcard, so `node_modules/` would also claim
    // `nodeXmodules/`. SQLite's LIKE is case-insensitive for ASCII too.
    `SELECT path, directory, reason, detail FROM excluded_paths
      WHERE path = ?1 OR (directory = 1 AND substr(?1, 1, LENGTH(path) + 1) = path || '/')
      ORDER BY LENGTH(path) DESC
      LIMIT 1`,
    [path],
  );
  if (!row) return null;
  return {
    path: row.path,
    directory: row.directory === 1,
    reason: row.reason,
    detail: row.detail,
  };
}

export function overviewView(db: Db): OverviewView {
  const lastAnalysis = db.get<{
    id: number;
    kind: string;
    started_at: string;
    git_sha: string | null;
  }>(
    `SELECT r.id, r.kind, r.started_at, r.git_sha
     FROM runs r
     WHERE r.id = (SELECT MAX(run_id) FROM tool_runs)`,
  );

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
    lastRun: lastAnalysis
      ? {
          kind: lastAnalysis.kind,
          startedAt: lastAnalysis.started_at,
          gitSha: lastAnalysis.git_sha,
        }
      : null,
    tools:
      lastAnalysis == null
        ? []
        : db.all<{ tool: string; status: string; findings: number; detail: string | null }>(
            "SELECT tool, status, findings, detail FROM tool_runs WHERE run_id = ? ORDER BY tool",
            [lastAnalysis.id],
          ),
    inputBoundary: inputBoundaryView(db),
  };
}

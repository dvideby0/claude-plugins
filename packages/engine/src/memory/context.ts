/**
 * Everything the store knows about one thing.
 *
 * The point is that an agent should not have to ask five questions before
 * touching a file. One call returns the shape of it, what depends on it, what
 * is already known to be wrong with it, and what a previous session recorded
 * about why it is the way it is.
 */

import type { Db } from "../db/db.js";
import { incomingReferenceCoverage } from "../graph/refs.js";
import { annotatedSymbols, memoriesForPath, memoriesForSymbolName, type Memory } from "./store.js";
import { likeEscape } from "../lib/sql.js";

export interface Neighbourhood {
  resolved: string | null;
  kind: "file" | "symbol" | "unknown";
  file: {
    path: string;
    lang: string;
    loc: number;
    churn: number;
    isTest: boolean;
    /** none means zero reference counts are unknown, not evidence of no uses. */
    referenceCoverage: "none" | "import" | "typed";
  } | null;
  symbols: Array<{
    kind: string;
    name: string;
    startLine: number;
    exported: boolean;
    /** How many places use this symbol. Blast radius, per export. */
    references: number;
    /** Memories anchored to this symbol specifically, not just its file. */
    notes: number;
    /** Declaration line. For a constant this carries its allowed values. */
    signature: string | null;
  }>;
  importers: string[];
  imports: string[];
  externals: string[];
  findings: Array<{
    id: string;
    rule: string;
    severity: string;
    status: string;
    line: number | null;
    title: string;
    suggestion: string | null;
  }>;
  memories: Memory[];
  /** Memories on the files that import this one — usually why it exists. */
  nearbyMemories: Memory[];
  /** Set when the target matched more than one file, so the caller can retry. */
  candidates?: string[];
}

/**
 * Accepts a path, a path suffix, or a symbol name.
 *
 * Agents refer to files the way people do — "db.ts", not the full path from
 * the repository root — so an exact match is tried first and a suffix match
 * second, and an ambiguous suffix returns the candidates rather than guessing.
 */
function resolveTarget(
  db: Db,
  target: string,
): { path: string | null; kind: Neighbourhood["kind"]; candidates?: string[] } {
  const exact = db.get<{ path: string }>(
    "SELECT path FROM files WHERE path = ? AND present = 1",
    [target],
  );
  if (exact) return { path: exact.path, kind: "file" };

  const escaped = likeEscape(target);
  const bySuffix = db.all<{ path: string }>(
    "SELECT path FROM files WHERE present = 1 AND (path = ? OR path LIKE ? ESCAPE '\\') ORDER BY LENGTH(path) LIMIT 25",
    [target, `%/${escaped}`],
  );
  if (bySuffix.length === 1) return { path: bySuffix[0]!.path, kind: "file" };
  if (bySuffix.length > 1) {
    return { path: null, kind: "unknown", candidates: bySuffix.map((row) => row.path) };
  }

  const symbol = db.all<{ path: string }>(
    "SELECT DISTINCT path FROM symbols WHERE name = ? LIMIT 25",
    [target],
  );
  if (symbol.length === 1) {
    return {
      path: symbol[0]!.path,
      kind: "symbol",
    };
  }
  if (symbol.length > 1) {
    return { path: null, kind: "unknown", candidates: symbol.map((row) => row.path) };
  }

  return { path: null, kind: "unknown" };
}

const column = <T>(db: Db, sql: string, params: Array<string | number>): T[] =>
  db.all<Record<string, T>>(sql, params).map((row) => Object.values(row)[0] as T);

export function neighbourhood(db: Db, target: string, limit = 40): Neighbourhood {
  const resolved = resolveTarget(db, target);

  const empty: Neighbourhood = {
    resolved: null,
    kind: "unknown",
    file: null,
    symbols: [],
    importers: [],
    imports: [],
    externals: [],
    findings: [],
    memories: [],
    nearbyMemories: [],
  };

  if (!resolved.path) {
    return {
      ...empty,
      kind: resolved.kind,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }
  const path = resolved.path;

  const file = db.get<{
    path: string;
    lang: string;
    loc: number;
    churn: number;
    is_test: number;
    ref_coverage: "none" | "import" | "typed";
  }>("SELECT path, lang, loc, churn, is_test, ref_coverage FROM files WHERE path = ?", [path]);

  const importers = column<string>(
    db,
    "SELECT src_path FROM edges WHERE dst_path = ? ORDER BY src_path LIMIT ?",
    [path, limit],
  );
  const imports = column<string>(
    db,
    "SELECT dst_path FROM edges WHERE src_path = ? AND dst_path IS NOT NULL ORDER BY dst_path LIMIT ?",
    [path, limit],
  );

  const annotated = annotatedSymbols(db, path);

  // Asking about a symbol should surface what was recorded against that
  // symbol, wherever it was recorded, ahead of notes about its whole file.
  const own =
    resolved.kind === "symbol"
      ? [
          ...memoriesForSymbolName(db, target),
          ...memoriesForPath(db, path).filter(
            (memory) => !memory.anchors.some((anchor) => anchor.symbol === target),
          ),
        ]
      : memoriesForPath(db, path);

  /**
   * Both directions matter, and imports matter most. A rule recorded against a
   * dependency ("never interpolate into query()") is a constraint on the file
   * being edited; what the importers know is the reason it exists at all.
   */
  const nearby: Memory[] = [];
  const seen = new Set(own.map((memory) => memory.id));
  for (const neighbour of [...imports.slice(0, 10), ...importers.slice(0, 10)]) {
    for (const memory of memoriesForPath(db, neighbour)) {
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      nearby.push(memory);
    }
  }

  return {
    resolved: path,
    kind: resolved.kind,
    ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    file: file
      ? {
          path: file.path,
          lang: file.lang,
          loc: file.loc,
          churn: file.churn,
          isTest: file.is_test === 1,
          // The counts below are incoming uses, produced by source files
          // across the repository. The declaration file's own outgoing
          // coverage can remain typed while a changed importer is temporarily
          // downgraded, so it cannot justify a negative reference result.
          referenceCoverage: incomingReferenceCoverage(db),
        }
      : null,
    symbols: db
      .all<{
        id: string;
        kind: string;
        name: string;
        start_line: number;
        exported: number;
        ref_count: number;
        signature: string | null;
      }>(
        `SELECT s.id, s.kind, s.name, s.start_line, s.exported, s.signature,
                (SELECT COUNT(*) FROM refs r
                 WHERE r.src_path != s.path AND
                   (r.dst_symbol_id = s.id OR
                    (r.dst_symbol_id IS NULL AND r.dst_path = s.path AND r.name = s.name AND
                     (SELECT COUNT(*) FROM symbols same
                       WHERE same.path = s.path AND same.name = s.name) = 1))) AS ref_count
         FROM symbols s WHERE s.path = ? ORDER BY ref_count DESC, s.start_line LIMIT ?`,
        [path, limit * 2],
      )
      .map((row) => ({
        kind: row.kind,
        name: row.name,
        startLine: row.start_line,
        exported: row.exported === 1,
        references: row.ref_count,
        notes: annotated.get(row.name) ?? 0,
        signature: row.signature,
      })),
    importers,
    imports,
    externals: column<string>(
      db,
      "SELECT DISTINCT external FROM edges WHERE src_path = ? AND external IS NOT NULL ORDER BY external LIMIT ?",
      [path, limit],
    ),
    findings: db
      .all<{
        id: string;
        rule_id: string;
        severity: string;
        status: string;
        line_start: number | null;
        title: string;
        suggestion: string | null;
      }>(
        `SELECT id, rule_id, severity, status, line_start, title, suggestion
         FROM findings WHERE path = ? AND status IN ('open','regressed')
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
        [path],
      )
      .map((row) => ({
        id: row.id,
        rule: row.rule_id,
        severity: row.severity,
        status: row.status,
        line: row.line_start,
        title: row.title,
        suggestion: row.suggestion,
      })),
    memories: own,
    nearbyMemories: nearby,
  };
}

/**
 * Symbol-level questions.
 *
 * The edges table answers "which files import this file". This answers "which
 * lines use this function", which is the question anyone actually has before
 * changing a signature.
 *
 * Resolution is import-based: a name imported from a module and used in the
 * body resolves to that module's definition. That covers exported functions,
 * classes and constants across files. It does not resolve method calls on
 * inferred types — for that a type-aware indexer (SCIP) is the upgrade path.
 */

import type { Db } from "../db/db.js";
import { memoriesForSymbolName, type Memory } from "../memory/store.js";
import { likeEscape } from "../lib/sql.js";

export interface CallSite {
  path: string;
  line: number;
}

export interface SymbolReferences {
  name: string;
  definedIn: string | null;
  kind: string | null;
  startLine: number | null;
  exported: boolean;
  total: number;
  /** Uses from other files. This is the blast radius. */
  external: number;
  /** Uses inside the defining file itself. Real, but not blast radius. */
  internal: number;
  callSites: CallSite[];
  /** Distinct other files using it — the real total, not just this page. */
  fileCount: number;
  /** The files on this page of call sites. */
  files: string[];
  /** What previous sessions recorded about this symbol. */
  notes: Memory[];
  /** Zero is only a negative result when this is not `none`. */
  referenceCoverage: "none" | "import" | "typed";
  candidates?: Array<{ name: string; path: string }>;
}

export function referencesTo(db: Db, name: string, limit = 100): SymbolReferences {
  const definition = db.get<{
    path: string;
    kind: string;
    start_line: number;
    exported: number;
    ref_coverage: "none" | "import" | "typed";
  }>(
    `SELECT s.path, s.kind, s.start_line, s.exported, f.ref_coverage
       FROM symbols s JOIN files f ON f.path = s.path
      WHERE s.name = ? ORDER BY s.exported DESC LIMIT 1`,
    [name],
  );

  const others = db.all<{ name: string; path: string }>(
    "SELECT DISTINCT name, path FROM symbols WHERE name = ?",
    [name],
  );

  const rows = definition
    ? db.all<{ src_path: string; src_line: number }>(
        "SELECT src_path, src_line FROM refs WHERE name = ? AND dst_path = ? ORDER BY src_path, src_line LIMIT ?",
        [name, definition.path, limit],
      )
    : db.all<{ src_path: string; src_line: number }>(
        "SELECT src_path, src_line FROM refs WHERE name = ? AND dst_path IS NOT NULL ORDER BY src_path, src_line LIMIT ?",
        [name, limit],
      );

  const total = definition
    ? db.count("SELECT COUNT(*) AS n FROM refs WHERE name = ? AND dst_path = ?", [
        name,
        definition.path,
      ])
    : db.count("SELECT COUNT(*) AS n FROM refs WHERE name = ? AND dst_path IS NOT NULL", [name]);

  // Counted with their own queries, not from `rows`. Deriving them from a
  // LIMITed page made "48 uses across 5 files" mean "5 files in the first
  // page" — a number that shrinks as you ask for less, which is worse than
  // no number at all.
  const internal = definition
    ? db.count("SELECT COUNT(*) AS n FROM refs WHERE name = ? AND dst_path = ? AND src_path = ?", [
        name,
        definition.path,
        definition.path,
      ])
    : 0;

  const fileCount = definition
    ? db.count(
        "SELECT COUNT(DISTINCT src_path) AS n FROM refs WHERE name = ? AND dst_path = ? AND src_path != ?",
        [name, definition.path, definition.path],
      )
    : db.count(
        "SELECT COUNT(DISTINCT src_path) AS n FROM refs WHERE name = ? AND dst_path IS NOT NULL",
        [name],
      );

  return {
    name,
    definedIn: definition?.path ?? null,
    kind: definition?.kind ?? null,
    startLine: definition?.start_line ?? null,
    exported: definition?.exported === 1,
    total,
    external: total - internal,
    internal,
    callSites: rows.map((row) => ({ path: row.src_path, line: row.src_line })),
    fileCount,
    /** The distinct files on this page. Use fileCount for the true total. */
    files: [
      ...new Set(
        rows.map((row) => row.src_path).filter((path) => path !== definition?.path),
      ),
    ],
    notes: memoriesForSymbolName(db, name),
    referenceCoverage: definition?.ref_coverage ?? "none",
    ...(others.length > 1 ? { candidates: others } : {}),
  };
}

export interface Impact {
  target: string;
  resolved: string | null;
  /** Symbols this file exports, each with how widely it is used. */
  symbols: Array<{
    name: string;
    kind: string;
    startLine: number;
    references: number;
    files: number;
  }>;
  /** Files that would need looking at if this file changed. */
  affectedFiles: string[];
  /** Of those, the ones that are tests — the safety net that already exists. */
  coveringTests: string[];
  directImporters: number;
  /** Uses from other files — the blast radius. */
  totalReferences: number;
  /** Uses within the file itself. Excluded from the numbers above. */
  internalReferences: number;
  /** `none` means all reference-derived zeroes are unknown rather than empty. */
  referenceCoverage: "none" | "import" | "typed";
}

/**
 * What would need re-checking if this file changed.
 *
 * Importers give the outer bound; references give the precise set, and the
 * split between them is the useful part — a file with 19 importers but 3 real
 * call sites is a much smaller change than the import graph suggests.
 */
export function impactOf(db: Db, target: string, limit = 200): Impact {
  // Escaped: an unescaped suffix match can resolve the impact question
  // against the wrong file entirely.
  const escaped = likeEscape(target);
  const file = db.get<{ path: string; ref_coverage: "none" | "import" | "typed" }>(
    "SELECT path, ref_coverage FROM files WHERE (path = ? OR path LIKE ? ESCAPE '\\') AND present = 1 ORDER BY LENGTH(path) LIMIT 1",
    [target, `%/${escaped}`],
  );

  if (!file) {
    return {
      target,
      resolved: null,
      symbols: [],
      affectedFiles: [],
      coveringTests: [],
      directImporters: 0,
      totalReferences: 0,
      internalReferences: 0,
      referenceCoverage: "none",
    };
  }

  const symbols = db.all<{
    name: string;
    kind: string;
    start_line: number;
    ref_count: number;
    files: number;
  }>(
    `SELECT s.name, s.kind, s.start_line,
            (SELECT COUNT(*) FROM refs r
               WHERE r.dst_path = s.path AND r.name = s.name AND r.src_path != s.path) AS ref_count,
            (SELECT COUNT(DISTINCT r.src_path) FROM refs r
               WHERE r.dst_path = s.path AND r.name = s.name AND r.src_path != s.path) AS files
     FROM symbols s WHERE s.path = ? AND s.exported = 1
     ORDER BY ref_count DESC, s.start_line LIMIT ?`,
    [file.path, limit],
  );

  const affected = db
    .all<{ src_path: string }>(
      "SELECT DISTINCT src_path FROM refs WHERE dst_path = ? AND src_path != ? ORDER BY src_path LIMIT ?",
      [file.path, file.path, limit],
    )
    .map((row) => row.src_path);

  const tests = affected.filter(
    (path) =>
      db.get<{ is_test: number }>("SELECT is_test FROM files WHERE path = ?", [path])?.is_test === 1,
  );

  return {
    target,
    resolved: file.path,
    symbols: symbols.map((row) => ({
      name: row.name,
      kind: row.kind,
      startLine: row.start_line,
      references: row.ref_count,
      files: row.files,
    })),
    affectedFiles: affected,
    coveringTests: tests,
    directImporters: db.count("SELECT COUNT(*) AS n FROM edges WHERE dst_path = ?", [file.path]),
    totalReferences: db.count(
      "SELECT COUNT(*) AS n FROM refs WHERE dst_path = ? AND src_path != ?",
      [file.path, file.path],
    ),
    internalReferences: db.count(
      "SELECT COUNT(*) AS n FROM refs WHERE dst_path = ? AND src_path = ?",
      [file.path, file.path],
    ),
    referenceCoverage: file.ref_coverage,
  };
}

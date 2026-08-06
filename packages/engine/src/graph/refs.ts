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
import { memoriesForSymbol, memoriesForSymbolName, type Memory } from "../memory/store.js";
import { likeEscape } from "../lib/sql.js";

export interface CallSite {
  path: string;
  line: number;
  column: number;
}

export interface ReferenceCandidate {
  symbolId: string;
  name: string;
  path: string;
  kind: string;
  startLine: number;
}

export interface ReferenceSelector {
  /** Exact declaration identity returned by flow, trace, context, or candidates. */
  symbolId?: string;
  /** File containing the declaration. */
  path?: string;
  /** Declaration line, for same-named symbols in one file. */
  line?: number;
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
  candidates?: ReferenceCandidate[];
}

/**
 * Incoming references are produced by their source files. A declaration file
 * remaining typed says nothing about an importer that was just re-parsed and
 * temporarily downgraded, so coverage is the weakest source-file coverage in
 * the repository rather than the destination's own outgoing coverage.
 */
export function incomingReferenceCoverage(db: Db): "none" | "import" | "typed" {
  const rows = db.all<{ ref_coverage: "none" | "import" | "typed" }>(
    `SELECT ref_coverage FROM files
      WHERE present = 1 AND lang IN ('typescript','javascript','python')`,
  );
  if (rows.length === 0 || rows.some((row) => row.ref_coverage === "none")) return "none";
  if (rows.some((row) => row.ref_coverage === "import")) return "import";
  return "typed";
}

export function referencesTo(
  db: Db,
  name: string,
  limit = 100,
  selector: ReferenceSelector = {},
): SymbolReferences {
  interface Definition {
    id: string;
    path: string;
    kind: string;
    start_line: number;
    exported: number;
  }

  const definitions = db.all<Definition>(
    `SELECT s.id, s.path, s.kind, s.start_line, s.exported
       FROM symbols s JOIN files f ON f.path = s.path
      WHERE s.name = ? AND f.present = 1
      ORDER BY s.exported DESC, s.path, s.start_line, s.start_column`,
    [name],
  );

  const narrowed = definitions.filter(
    (candidate) =>
      (!selector.path || candidate.path === selector.path) &&
      (!selector.line || candidate.start_line === selector.line),
  );
  const definition = selector.symbolId
    ? definitions.find((candidate) => candidate.id === selector.symbolId)
    : selector.path || selector.line
      ? narrowed.length === 1
        ? narrowed[0]
        : undefined
      : definitions.length === 1
        ? definitions[0]
        : undefined;

  // Old stores can briefly contain refs without declaration ids while an
  // upgraded index is being refreshed. Name/path fallback is safe only when
  // the destination file has one declaration with that name.
  const legacyDestinationIsUnambiguous = Boolean(
    definition && definitions.filter((candidate) => candidate.path === definition.path).length === 1,
  );
  const referenceWhere = definition
    ? `dst_symbol_id = ?${
        legacyDestinationIsUnambiguous
          ? " OR (dst_symbol_id IS NULL AND name = ? AND dst_path = ?)"
          : ""
      }`
    : "0";
  const referenceParams: Array<string | number> = definition
    ? [
        definition.id,
        ...(legacyDestinationIsUnambiguous ? [name, definition.path] : []),
      ]
    : [];

  const rows = definition
    ? db.all<{ src_path: string; src_line: number; src_column: number }>(
        `SELECT src_path, src_line, src_column FROM refs
          WHERE (${referenceWhere}) ORDER BY src_path, src_line, src_column LIMIT ?`,
        [...referenceParams, limit],
      )
    : [];

  const total = definition
    ? db.count(`SELECT COUNT(*) AS n FROM refs WHERE (${referenceWhere})`, referenceParams)
    : 0;

  // Counted with their own queries, not from `rows`. Deriving them from a
  // LIMITed page made "48 uses across 5 files" mean "5 files in the first
  // page" — a number that shrinks as you ask for less, which is worse than
  // no number at all.
  const internal = definition
    ? db.count(
        `SELECT COUNT(*) AS n FROM refs WHERE (${referenceWhere}) AND src_path = ?`,
        [...referenceParams, definition.path],
      )
    : 0;

  const fileCount = definition
    ? db.count(
        `SELECT COUNT(DISTINCT src_path) AS n FROM refs
          WHERE (${referenceWhere}) AND src_path != ?`,
        [...referenceParams, definition.path],
      )
    : 0;

  return {
    name,
    definedIn: definition?.path ?? null,
    kind: definition?.kind ?? null,
    startLine: definition?.start_line ?? null,
    exported: definition?.exported === 1,
    total,
    external: total - internal,
    internal,
    callSites: rows.map((row) => ({
      path: row.src_path,
      line: row.src_line,
      column: row.src_column,
    })),
    fileCount,
    /** The distinct files on this page. Use fileCount for the true total. */
    files: [
      ...new Set(
        rows.map((row) => row.src_path).filter((path) => path !== definition?.path),
      ),
    ],
    // A same-named declaration in another file may carry completely different
    // constraints. Once this query identifies a declaration, its notes must be
    // scoped to that file; an unresolved name can still surface orphaned or
    // repository-wide symbol notes when there is no live declaration at all.
    notes: definition
      ? memoriesForSymbol(db, definition.path, name)
      : definitions.length === 0
        ? memoriesForSymbolName(db, name)
        : [],
    referenceCoverage: definition ? incomingReferenceCoverage(db) : "none",
    ...(definitions.length > 1
      ? {
          candidates: definitions.map((candidate) => ({
            symbolId: candidate.id,
            name,
            path: candidate.path,
            kind: candidate.kind,
            startLine: candidate.start_line,
          })),
        }
      : {}),
  };
}

export interface Impact {
  target: string;
  resolved: string | null;
  /** Exact candidates when a suffix names more than one present file. */
  candidates?: string[];
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
  const exact = db.get<{ path: string }>(
    "SELECT path FROM files WHERE path = ? AND present = 1",
    [target],
  );
  // Escaped: an unescaped suffix match can resolve the impact question
  // against the wrong file entirely. A suffix must also be unique; choosing
  // one of two db.ts files would return confident facts about the wrong code.
  const matches = exact
    ? [exact]
    : db.all<{ path: string }>(
        "SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' AND present = 1 ORDER BY path",
        [`%/${likeEscape(target)}`],
      );
  const file = matches.length === 1 ? matches[0] : null;

  if (!file) {
    return {
      target,
      resolved: null,
      ...(matches.length > 1 ? { candidates: matches.map((match) => match.path) } : {}),
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
               WHERE r.src_path != s.path AND
                 (r.dst_symbol_id = s.id OR
                  (r.dst_symbol_id IS NULL AND r.dst_path = s.path AND r.name = s.name AND
                   (SELECT COUNT(*) FROM symbols same
                     WHERE same.path = s.path AND same.name = s.name) = 1))) AS ref_count,
            (SELECT COUNT(DISTINCT r.src_path) FROM refs r
               WHERE r.src_path != s.path AND
                 (r.dst_symbol_id = s.id OR
                  (r.dst_symbol_id IS NULL AND r.dst_path = s.path AND r.name = s.name AND
                   (SELECT COUNT(*) FROM symbols same
                     WHERE same.path = s.path AND same.name = s.name) = 1))) AS files
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
    referenceCoverage: incomingReferenceCoverage(db),
  };
}

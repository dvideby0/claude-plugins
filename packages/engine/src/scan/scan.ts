/**
 * Scan orchestration.
 *
 * Incremental by default: files whose content hash is unchanged keep their
 * symbols, edges and findings. Only changed files are re-parsed.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/db.js";
import { getDb } from "../db/db.js";
import { parseFile } from "./parse.js";
import { createResolver, parseTsAliases, type TsPathAlias } from "./resolve.js";
import { collectGit } from "./git.js";
import { TYPED_SPECIFIER } from "../graph/typed.js";
import { collectFiles } from "./source.js";
import { isNoise } from "./walk.js";
import { canonicalWorkspaceRoot, workspaceIdentityKey } from "../lib/workspace-path.js";

/**
 * Bumped whenever the parsers start producing something they did not before.
 *
 * A schema migration adds the column; it cannot fill it. An incremental scan
 * only re-parses files whose content changed, so a repository indexed before a
 * new capability shipped keeps an index silently missing it — references were
 * empty on a real repository for exactly this reason, and `flow` reported "no
 * entry points" rather than "this index predates them".
 *
 * When the stored version is behind, the next scan is promoted to a full one.
 */
export const EXTRACTION_VERSION = 6;

export interface ScanOptions {
  /** Re-parse every file, ignoring content hashes. */
  full?: boolean;
  kind?: string;
}

export interface ScanResult {
  runId: number;
  filesTotal: number;
  filesParsed: number;
  filesChanged: number;
  filesRemoved: number;
  symbols: number;
  edges: number;
  unresolvedImports: number;
  externalPackages: number;
  references: number;
  languages: Record<string, number>;
  gitAvailable: boolean;
  /** Which implementation walked and parsed: "native" or "typescript". */
  engine: string;
  /** True when the index was rebuilt because it predated the current extractor. */
  upgraded: boolean;
}

async function loadAliases(projectRoot: string): Promise<TsPathAlias[]> {
  try {
    return parseTsAliases(await readFile(join(projectRoot, "tsconfig.json"), "utf-8"));
  } catch {
    return [];
  }
}

export async function startRun(db: Db, kind: string, gitSha: string | null): Promise<number> {
  db.run("INSERT INTO runs(kind, started_at, git_sha) VALUES(?, ?, ?)", [
    kind,
    new Date().toISOString(),
    gitSha,
  ]);
  return db.lastInsertId();
}

// One scan per store at a time. The watcher, the HTTP index job and the MCP
// `audit_scan` tool are three independent doors into this function; two scans
// interleaving on one sql.js handle means nested transactions and torn state.
const scans = new Map<string, Promise<unknown>>();

export async function scan(projectRoot: string, options: ScanOptions = {}): Promise<ScanResult> {
  const canonical = await canonicalWorkspaceRoot(projectRoot);
  const key = workspaceIdentityKey(canonical);
  const prior = scans.get(key) ?? Promise.resolve();
  const run = prior.then(
    () => doScan(canonical, options),
    () => doScan(canonical, options),
  );
  scans.set(key, run);
  return run as Promise<ScanResult>;
}

async function doScan(projectRoot: string, options: ScanOptions = {}): Promise<ScanResult> {
  const db = await getDb(projectRoot);
  const git = await collectGit(projectRoot);
  const runId = await startRun(db, options.kind ?? "scan", git.sha);

  // Promote to a full scan when the index was built by an older extractor.
  const storedVersion = Number(
    db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'extraction_version'")?.value ?? 0,
  );
  const stale = storedVersion < EXTRACTION_VERSION;
  const full = options.full || stale;

  const { files, engine } = await collectFiles(projectRoot);
  const aliases = await loadAliases(projectRoot);

  const previous = new Map(
    db
      .all<{ path: string; content_sha: string }>(
        "SELECT path, content_sha FROM files WHERE present = 1",
      )
      .map((row) => [row.path, row.content_sha]),
  );

  const seen = new Set<string>();
  const languages: Record<string, number> = {};
  let filesChanged = 0;
  let filesParsed = 0;

  // Parse before the transaction opens. The write pass below is synchronous
  // on purpose: an `await` inside an open transaction lets unrelated writes
  // join it — and a failure would roll them back too (see Db.transaction).
  const parseable = (path: string, lang: string): boolean =>
    !isNoise(path) && (lang === "typescript" || lang === "javascript" || lang === "python");
  const parsed = new Map<string, Awaited<ReturnType<typeof parseFile>>>();
  for (const file of files) {
    const changed = full || previous.get(file.path) !== file.contentSha;
    if (!changed || !parseable(file.path, file.lang)) continue;
    // The native core has already parsed everything; the TypeScript path
    // parses here, so that only changed files pay for it.
    parsed.set(file.path, file.parsed ?? (await parseFile(file.path, file.lang, file.content ?? "")));
  }

  const walked = new Set(files.map((file) => file.path));
  const removed = [...previous.keys()].filter((path) => !walked.has(path));

  db.transaction(() => {
    for (const file of files) {
      seen.add(file.path);
      languages[file.lang] = (languages[file.lang] ?? 0) + 1;
      const refreshed = parsed.has(file.path);
      const referenceCoverage =
        refreshed && engine === "native" && parseable(file.path, file.lang) ? "import" : "none";

      db.run(
        `INSERT INTO files(path, lang, loc, bytes, content_sha, churn, is_test, parsed, ref_coverage, present,
                           first_seen_run, last_seen_run)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           lang = excluded.lang, loc = excluded.loc, bytes = excluded.bytes,
           content_sha = excluded.content_sha, churn = excluded.churn,
           is_test = excluded.is_test,
           ref_coverage = CASE WHEN ? = 1 THEN excluded.ref_coverage ELSE files.ref_coverage END,
           present = 1, last_seen_run = excluded.last_seen_run`,
        [
          file.path,
          file.lang,
          file.loc,
          file.bytes,
          file.contentSha,
          git.churn.get(file.path) ?? 0,
          file.isTest ? 1 : 0,
          parseable(file.path, file.lang) ? 1 : 0,
          referenceCoverage,
          runId,
          runId,
          refreshed ? 1 : 0,
        ],
      );

      const result = parsed.get(file.path);
      if (!result) continue;
      filesChanged++;
      filesParsed++;

      db.run("DELETE FROM symbols WHERE path = ?", [file.path]);
      db.run("DELETE FROM edges WHERE src_path = ?", [file.path]);
      db.run("DELETE FROM refs WHERE src_path = ?", [file.path]);

      for (const symbol of result.symbols) {
        db.run(
          `INSERT OR REPLACE INTO symbols(id, path, kind, name, start_line, start_column,
                                          end_line, end_column, exported, default_export, signature)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `${file.path}#${symbol.kind}:${symbol.name}@${symbol.startLine}:${symbol.startColumn}`,
            file.path,
            symbol.kind,
            symbol.name,
            symbol.startLine,
            symbol.startColumn,
            symbol.endLine,
            symbol.endColumn,
            symbol.exported ? 1 : 0,
            symbol.defaultExport ? 1 : 0,
            symbol.signature,
          ],
        );
      }

      for (const specifier of result.imports) {
        db.run(
          "INSERT OR REPLACE INTO edges(src_path, specifier, dst_path, external) VALUES(?, ?, NULL, NULL)",
          [file.path, specifier],
        );
      }

      for (const reference of file.refs) {
        db.run(
          `INSERT OR REPLACE INTO refs(src_path, src_line, src_column, name, specifier, dst_path)
           VALUES(?, ?, ?, ?, ?, NULL)`,
          [file.path, reference.line, reference.column, reference.name, reference.module],
        );
      }
    }

    // Files that disappeared: keep the row for history, retire their graph and
    // close any findings that pointed at them. Refs *into* them go too — the
    // typed pass is the only thing that would heal those, and it only runs
    // after a scan that parsed something.
    for (const path of removed) {
      db.run("UPDATE files SET present = 0 WHERE path = ?", [path]);
      db.run("DELETE FROM symbols WHERE path = ?", [path]);
      db.run("DELETE FROM edges WHERE src_path = ?", [path]);
      db.run("DELETE FROM refs WHERE src_path = ?", [path]);
      db.run("DELETE FROM refs WHERE dst_path = ?", [path]);
      db.run(
        "UPDATE findings SET status = 'fixed', fixed_in_run = ? WHERE path = ? AND status IN ('open','regressed')",
        [runId, path],
      );
    }

    // Re-resolve every edge: a newly added file can resolve an import that was
    // external on the previous run.
    const resolver = createResolver(seen, aliases);
    const edges = db.all<{ src_path: string; specifier: string }>(
      "SELECT src_path, specifier FROM edges",
    );
    for (const edge of edges) {
      const { dstPath, external } = resolver.resolve(edge.src_path, edge.specifier);
      db.run("UPDATE edges SET dst_path = ?, external = ? WHERE src_path = ? AND specifier = ?", [
        dstPath,
        external,
        edge.src_path,
        edge.specifier,
      ]);
    }

    // Refs resolve through the same specifier -> file mapping as edges — except
    // the type-resolved ones, which already carry a real target. Passing those
    // through the import resolver nulls them out, silently undoing the typed
    // pass on the next scan.
    const references = db.all<{ src_path: string; specifier: string }>(
      "SELECT DISTINCT src_path, specifier FROM refs WHERE specifier != ? AND specifier NOT LIKE ?",
      [TYPED_SPECIFIER, `${TYPED_SPECIFIER}:%`],
    );
    for (const reference of references) {
      const { dstPath } = resolver.resolve(reference.src_path, reference.specifier);
      db.run("UPDATE refs SET dst_path = ? WHERE src_path = ? AND specifier = ?", [
        dstPath,
        reference.src_path,
        reference.specifier,
      ]);
    }

    // A default import is locally named by the importer, but its declaration
    // can have a different real name (`export default function start`). Keep
    // refs keyed to declaration identity, not the export-slot spelling.
    db.run(
      `UPDATE refs SET name = (
         SELECT s.name FROM symbols s
         WHERE s.path = refs.dst_path AND s.default_export = 1
         ORDER BY s.start_line ASC LIMIT 1
       )
       WHERE refs.name = 'default' AND refs.dst_path IS NOT NULL
         AND 1 = (SELECT COUNT(*) FROM symbols s
                  WHERE s.path = refs.dst_path AND s.default_export = 1)`,
    );

    // The innermost enclosing declaration is the caller. Destination ids use
    // typed declaration lines where available, so duplicate method names stay
    // distinct instead of collapsing to path + name.
    db.refreshReferenceIdentity();
  });

  const symbolCount = db.count("SELECT COUNT(*) AS n FROM symbols");
  const edgeCount = db.count("SELECT COUNT(*) AS n FROM edges");
  const unresolved = db.count(
    "SELECT COUNT(*) AS n FROM edges WHERE dst_path IS NULL AND external IS NULL",
  );
  const externals = db.count(
    "SELECT COUNT(DISTINCT external) AS n FROM edges WHERE external IS NOT NULL",
  );

  db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('extraction_version', ?)", [
    String(EXTRACTION_VERSION),
  ]);

  db.run(
    "UPDATE runs SET finished_at = ?, files_total = ?, files_changed = ? WHERE id = ?",
    [new Date().toISOString(), files.length, filesChanged, runId],
  );
  await db.flush();

  return {
    runId,
    filesTotal: files.length,
    filesParsed,
    filesChanged,
    filesRemoved: removed.length,
    symbols: symbolCount,
    edges: edgeCount,
    unresolvedImports: unresolved,
    externalPackages: externals,
    references: db.count("SELECT COUNT(*) AS n FROM refs WHERE dst_path IS NOT NULL"),
    languages,
    gitAvailable: git.available,
    engine,
    upgraded: stale,
  };
}

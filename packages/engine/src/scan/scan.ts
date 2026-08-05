/**
 * Scan orchestration.
 *
 * Incremental by default: files whose content hash is unchanged keep their
 * symbols, edges and findings. Only changed files are re-parsed.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Db } from "../db/db.js";
import { getDb } from "../db/db.js";
import { parseFile } from "./parse.js";
import { createResolver, parseTsAliases, type TsPathAlias } from "./resolve.js";
import { collectGit } from "./git.js";
import { TYPED_SPECIFIER } from "../graph/typed.js";
import { collectFiles } from "./source.js";
import { isNoise } from "./walk.js";

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
export const EXTRACTION_VERSION = 3;

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

export function scan(projectRoot: string, options: ScanOptions = {}): Promise<ScanResult> {
  const key = resolve(projectRoot);
  const prior = scans.get(key) ?? Promise.resolve();
  const run = prior.then(
    () => doScan(key, options),
    () => doScan(key, options),
  );
  scans.set(key, run);
  return run;
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

      db.run(
        `INSERT INTO files(path, lang, loc, bytes, content_sha, churn, is_test, parsed, present,
                           first_seen_run, last_seen_run)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           lang = excluded.lang, loc = excluded.loc, bytes = excluded.bytes,
           content_sha = excluded.content_sha, churn = excluded.churn,
           is_test = excluded.is_test, present = 1, last_seen_run = excluded.last_seen_run`,
        [
          file.path,
          file.lang,
          file.loc,
          file.bytes,
          file.contentSha,
          git.churn.get(file.path) ?? 0,
          file.isTest ? 1 : 0,
          parseable(file.path, file.lang) ? 1 : 0,
          runId,
          runId,
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
          `INSERT OR REPLACE INTO symbols(id, path, kind, name, start_line, end_line, exported, signature)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `${file.path}#${symbol.kind}:${symbol.name}@${symbol.startLine}`,
            file.path,
            symbol.kind,
            symbol.name,
            symbol.startLine,
            symbol.endLine,
            symbol.exported ? 1 : 0,
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
          "INSERT OR REPLACE INTO refs(src_path, src_line, name, specifier, dst_path) VALUES(?, ?, ?, ?, NULL)",
          [file.path, reference.line, reference.name, reference.module],
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
      "SELECT DISTINCT src_path, specifier FROM refs WHERE specifier != ?",
      [TYPED_SPECIFIER],
    );
    for (const reference of references) {
      const { dstPath } = resolver.resolve(reference.src_path, reference.specifier);
      db.run("UPDATE refs SET dst_path = ? WHERE src_path = ? AND specifier = ?", [
        dstPath,
        reference.src_path,
        reference.specifier,
      ]);
    }

    // Attribute each reference to the symbol whose line range encloses it. The
    // innermost wins, so a call inside a method is credited to the method rather
    // than to the class around it. Doing this in SQL after the fact keeps both
    // the fast pass and the typed pass from having to care.
    db.run(
      `UPDATE refs SET src_symbol = (
         SELECT s.name FROM symbols s
         WHERE s.path = refs.src_path
           AND s.start_line <= refs.src_line
           AND s.end_line   >= refs.src_line
         ORDER BY (s.end_line - s.start_line) ASC
         LIMIT 1
       )`,
    );
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

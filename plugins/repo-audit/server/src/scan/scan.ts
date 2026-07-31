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
import { isNoise, walk } from "./walk.js";

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
  languages: Record<string, number>;
  gitAvailable: boolean;
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

export async function scan(
  projectRoot: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const db = await getDb(projectRoot);
  const git = await collectGit(projectRoot);
  const runId = await startRun(db, options.kind ?? "scan", git.sha);

  const files = await walk(projectRoot);
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

  db.run("BEGIN");

  for (const file of files) {
    seen.add(file.path);
    languages[file.lang] = (languages[file.lang] ?? 0) + 1;

    const changed = options.full || previous.get(file.path) !== file.contentSha;
    const parseable =
      !isNoise(file.path) &&
      (file.lang === "typescript" || file.lang === "javascript" || file.lang === "python");

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
        parseable ? 1 : 0,
        runId,
        runId,
      ],
    );

    if (!changed || !parseable) continue;
    filesChanged++;

    const { symbols, imports } = await parseFile(file.path, file.lang, file.content);
    filesParsed++;

    db.run("DELETE FROM symbols WHERE path = ?", [file.path]);
    db.run("DELETE FROM edges WHERE src_path = ?", [file.path]);

    for (const symbol of symbols) {
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

    for (const specifier of imports) {
      db.run(
        "INSERT OR REPLACE INTO edges(src_path, specifier, dst_path, external) VALUES(?, ?, NULL, NULL)",
        [file.path, specifier],
      );
    }
  }

  // Files that disappeared: keep the row for history, retire their graph and
  // close any findings that pointed at them.
  const removed = [...previous.keys()].filter((path) => !seen.has(path));
  for (const path of removed) {
    db.run("UPDATE files SET present = 0 WHERE path = ?", [path]);
    db.run("DELETE FROM symbols WHERE path = ?", [path]);
    db.run("DELETE FROM edges WHERE src_path = ?", [path]);
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

  db.run("COMMIT");

  const symbolCount = db.count("SELECT COUNT(*) AS n FROM symbols");
  const edgeCount = db.count("SELECT COUNT(*) AS n FROM edges");
  const unresolved = db.count(
    "SELECT COUNT(*) AS n FROM edges WHERE dst_path IS NULL AND external IS NULL",
  );
  const externals = db.count(
    "SELECT COUNT(DISTINCT external) AS n FROM edges WHERE external IS NOT NULL",
  );

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
    languages,
    gitAvailable: git.available,
  };
}

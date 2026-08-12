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
import { createResolver, parseTsAliases, type TsPathAlias } from "./resolve.js";
import { collectGit } from "./git.js";
import { TYPED_SPECIFIER } from "../graph/typed-contract.js";
import { collectFiles, type ParsedSource } from "./source.js";
import { canonicalWorkspaceRoot, workspaceIdentityKey } from "../lib/workspace-path.js";
import { sourceSignature } from "./signature.js";

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
export const EXTRACTION_VERSION = 11;

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
  executionEntries: number;
  languages: Record<string, number>;
  gitAvailable: boolean;
  /** The bundled Rust source engine. */
  engine: "native";
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
// interleaving on one SQLite handle means nested transactions and torn state.
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
  const { files, engine } = await collectFiles(projectRoot);
  const storedEngine =
    db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'extraction_engine'")?.value ??
    "unknown";
  // Stores created by the retired TypeScript fallback lack imported-name
  // references. Rebuild them once through the sole production source engine.
  const stale = storedVersion < EXTRACTION_VERSION || storedEngine !== "native";
  const full = options.full || stale;
  const aliases = await loadAliases(projectRoot);

  const previous = new Map(
    db
      .all<{ path: string; content_sha: string }>(
        "SELECT path, content_sha FROM files WHERE present = 1",
      )
      .map((row) => [row.path, row.content_sha]),
  );

  const walked = new Set(files.map((file) => file.path));
  const removed = [...previous.keys()].filter((path) => !walked.has(path));
  const invalidatedSources = new Set<string>();
  for (const path of removed) {
    for (const row of db.all<{ src_path: string }>(
      "SELECT DISTINCT src_path FROM refs WHERE dst_path = ?",
      [path],
    )) {
      invalidatedSources.add(row.src_path);
    }
  }

  const seen = new Set<string>();
  const languages: Record<string, number> = {};
  let filesChanged = 0;
  let filesParsed = 0;

  // Rust has already walked and parsed before the transaction opens. Select
  // the changed parse results here so the write pass remains synchronous.
  const parsed = new Map<string, ParsedSource>();
  for (const file of files) {
    // A reference is owned by its caller. If its target disappears, rebuild
    // that unchanged caller now so the unresolved row survives and can resolve
    // again when the target returns. Deleting the inbound row permanently lost
    // the call until a full scan or an unrelated caller edit.
    const changed =
      full || previous.get(file.path) !== file.contentSha || invalidatedSources.has(file.path);
    if (!changed || !file.parsed) continue;
    parsed.set(file.path, file.parsed);
  }

  db.transaction(() => {
    for (const file of files) {
      seen.add(file.path);
      languages[file.lang] = (languages[file.lang] ?? 0) + 1;
      const refreshed = parsed.has(file.path);
      const referenceCoverage = refreshed ? "import" : "none";

      db.run(
        `INSERT INTO files(path, lang, loc, bytes, content_sha, churn, is_test, parsed,
                           ref_coverage, ref_generation, ref_source_signature, present,
                           first_seen_run, last_seen_run)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           lang = excluded.lang, loc = excluded.loc, bytes = excluded.bytes,
           content_sha = excluded.content_sha, churn = excluded.churn,
           is_test = excluded.is_test,
           ref_coverage = CASE WHEN ? = 1 THEN excluded.ref_coverage ELSE files.ref_coverage END,
           ref_generation = CASE WHEN ? = 1 THEN NULL ELSE files.ref_generation END,
           ref_source_signature = CASE WHEN ? = 1 THEN NULL ELSE files.ref_source_signature END,
           present = 1, last_seen_run = excluded.last_seen_run`,
        [
          file.path,
          file.lang,
          file.loc,
          file.bytes,
          file.contentSha,
          git.churn.get(file.path) ?? 0,
          file.isTest ? 1 : 0,
          file.parsed ? 1 : 0,
          referenceCoverage,
          runId,
          runId,
          refreshed ? 1 : 0,
          refreshed ? 1 : 0,
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
      db.run("DELETE FROM execution_entries WHERE path = ?", [file.path]);

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

      for (const entry of file.isTest ? [] : result.executionEntries) {
        db.run(
          `INSERT INTO execution_entries(
             id, kind, label, method, route, path, symbol, start_line, end_line,
             producer_id, producer_version, producer_kind, certainty, input_sha, indexed_run
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.kind,
            entry.label,
            entry.method,
            entry.route,
            entry.path,
            entry.symbol,
            entry.startLine,
            entry.endLine,
            entry.producerId,
            entry.producerVersion,
            entry.producerKind,
            entry.certainty,
            file.contentSha,
            runId,
          ],
        );
        for (const node of entry.nodes) {
          db.run(
            `INSERT INTO execution_nodes(
               id, entry_id, ordinal, kind, label, path, symbol, target_symbol,
               external, start_line, end_line, certainty, terminal, detail
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              node.id,
              entry.id,
              node.ordinal,
              node.kind,
              node.label,
              node.path,
              node.symbol,
              node.targetSymbol,
              node.external,
              node.startLine,
              node.endLine,
              node.certainty,
              node.terminal ? 1 : 0,
              node.detail,
            ],
          );
        }
        for (const edge of entry.edges) {
          db.run(
            `INSERT INTO execution_edges(
               entry_id, ordinal, src_id, dst_id, kind, label, path, start_line, certainty
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.id,
              edge.ordinal,
              edge.from,
              edge.to,
              edge.kind,
              edge.label,
              edge.path,
              edge.startLine,
              edge.certainty,
            ],
          );
        }
        entry.diagnostics.forEach((message, ordinal) => {
          db.run(
            "INSERT INTO execution_diagnostics(entry_id, ordinal, message) VALUES(?, ?, ?)",
            [entry.id, ordinal, message],
          );
        });
      }
    }

    // Files that disappeared: keep the row for history, retire their graph and
    // close any findings that pointed at them. Present callers were re-parsed
    // above, leaving unresolved refs that can heal if the target returns.
    for (const path of removed) {
      db.run("UPDATE files SET present = 0 WHERE path = ?", [path]);
      db.run("DELETE FROM symbols WHERE path = ?", [path]);
      db.run("DELETE FROM edges WHERE src_path = ?", [path]);
      db.run("DELETE FROM refs WHERE src_path = ?", [path]);
      db.run("DELETE FROM refs WHERE dst_path = ?", [path]);
      db.run("DELETE FROM execution_entries WHERE path = ?", [path]);
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

    // The innermost enclosing declaration is the caller. Destination ids use
    // typed declaration lines where available, so duplicate method names stay
    // distinct instead of collapsing to path + name.
    db.refreshReferenceIdentity();
    db.run(
      `UPDATE execution_nodes SET target_path = (
         SELECT r.dst_path FROM refs r
         WHERE r.src_path = execution_nodes.path
           AND r.name = execution_nodes.target_symbol
           AND r.dst_path IS NOT NULL
           AND r.src_line BETWEEN execution_nodes.start_line AND execution_nodes.end_line
         ORDER BY r.src_line, r.src_column
         LIMIT 1
       )
       WHERE execution_nodes.target_symbol != ''`,
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
  db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('extraction_engine', ?)", [engine]);
  db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('source_signature', ?)", [
    sourceSignature(files),
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
    executionEntries: db.count("SELECT COUNT(*) AS n FROM execution_entries"),
    languages,
    gitAvailable: git.available,
    engine,
    upgraded: stale,
  };
}

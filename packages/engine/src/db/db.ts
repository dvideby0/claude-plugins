/**
 * SQLite access. One writer (this server), one app-owned store per workspace.
 */

import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, open as openFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { storeDir } from "@sdlc/protocol";
import { NativeDatabase } from "@sdlc/scan-core";
import {
  canonicalWorkspaceRoot,
  workspaceIdentityKey,
  workspaceIdForCanonicalRoot,
} from "../lib/workspace-path.js";
import { TYPED_SPECIFIER, typedWorkspaceGeneration } from "../graph/typed-contract.js";

export type Params = Array<string | number | null>;

export const KNOWLEDGE_KINDS = [
  "file",
  "symbol",
  "memory",
  "finding",
  "component",
  "flow",
  "relation",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

interface NativeKnowledgeHit {
  kind: KnowledgeKind;
  source_id: string;
  title: string;
  path: string;
  symbol: string;
  updated_at: string | null;
  score: number;
  excerpt: string;
}

/** One ranked result from the Rust-owned FTS5 index. */
export interface KnowledgeHit {
  kind: KnowledgeKind;
  sourceId: string;
  title: string;
  path: string;
  symbol: string;
  updatedAt: string | null;
  score: number;
  excerpt: string;
}

export interface ExecutionEntrySummary {
  id: string;
  kind: string;
  label: string;
  method: string;
  route: string;
  path: string;
  symbol: string;
  evidence: { path: string; startLine: number; endLine: number };
  producer: { id: string; version: string; kind: string };
  certainty: string;
  freshness: "current" | "stale";
  generation: { inputSha: string };
  terminalEffects: number;
  gaps: number;
}

export interface ExecutionNodeView {
  id: string;
  ordinal: number;
  kind: string;
  label: string;
  path: string;
  symbol: string;
  target: { path: string | null; symbol: string; external: string };
  evidence: { path: string; startLine: number; endLine: number };
  certainty: string;
  terminal: boolean;
  detail: string;
}

export interface ExecutionEdgeView {
  id: number;
  from: string;
  to: string;
  kind: string;
  label: string;
  evidence: { path: string; startLine: number };
  certainty: string;
}

export interface ExecutionPathView {
  id: string;
  nodeIds: string[];
  edgeIds: number[];
  conditions: string[];
  terminalNodeId: string | null;
  terminalEffect: string | null;
  certainty: string;
  complete: boolean;
}

export interface ExecutionAssertionView {
  id: string;
  kind: string;
  label: string | null;
  from: { path: string; symbol: string | null };
  to: { path: string | null; symbol: string | null };
  evidence: { path: string; startLine: number | null; text: string };
  provenance: {
    source: string;
    certainty: "asserted";
    confidence: "definite" | "high" | "medium" | "low";
    freshness: "current";
  };
  anchors: Array<{ nodeId: string; relationEndpoint: "source" | "target" }>;
}

export interface ExecutionAssertedOverlayView {
  enabled: boolean;
  note: string;
  relations: ExecutionAssertionView[];
  truncated: boolean;
}

export interface ExecutionFlowView {
  schemaVersion: 2;
  model: "entry-to-effect";
  note?: string | null;
  entries: ExecutionEntrySummary[];
  diagnostics: string[];
  selected: {
    entry: ExecutionEntrySummary;
    nodes: ExecutionNodeView[];
    edges: ExecutionEdgeView[];
    paths: ExecutionPathView[];
    diagnostics: string[];
    truncated: boolean;
    assertedOverlay: ExecutionAssertedOverlayView;
  } | null;
}

/** Stable location for the current path-derived workspace identity. */
export function databasePathForWorkspace(canonicalRoot: string): string {
  return join(storeDir(), workspaceIdForCanonicalRoot(canonicalRoot), "audit.db");
}

/**
 * Copy the prototype's repository-local store once, leaving the source as a
 * recoverable backup. New writes always target app-owned storage.
 */
async function migrateLegacyStore(projectRoot: string, dbPath: string): Promise<void> {
  try {
    await access(dbPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const legacyPath = join(projectRoot, "sdlc-audit", "audit.db");
  try {
    await copyFile(legacyPath, dbPath, constants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") throw error;
  }
}

function migrationBackupDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

export class Db {
  private constructor(
    private readonly raw: NativeDatabase,
    readonly path: string,
  ) {}

  static async open(projectRoot: string, createIfMissing = true): Promise<Db> {
    const dbPath = databasePathForWorkspace(projectRoot);
    await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
    await migrateLegacyStore(projectRoot, dbPath);
    if (createIfMissing) {
      try {
        const file = await openFile(dbPath, "wx", 0o600);
        await file.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else {
      await access(dbPath);
    }
    await chmod(dbPath, 0o600);

    // NativeDatabase opens the file directly. A permission or corruption
    // failure propagates; it is never reinterpreted as permission to replace
    // an existing index with an empty store.
    let raw: NativeDatabase;
    try {
      raw = new NativeDatabase(dbPath, createIfMissing);
    } catch (error) {
      throw new Error(
        `Cannot open SQLite workspace store ${dbPath}. The store was left untouched; ` +
          `recovery backups, when available, are under ${join(dirname(dbPath), "backups")}. ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const db = new Db(raw, dbPath);
    try {
      await raw.migrate(projectRoot, migrationBackupDir(dbPath));
      db.refreshReferenceIdentity();
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the initialization failure, which is the actionable error.
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
          `SQLite workspace store ${dbPath} was closed without being replaced.`,
        { cause: error },
      );
    }
  }

  run(sql: string, params: Params = []): void {
    this.raw.run(sql, JSON.stringify(params));
  }

  all<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    return JSON.parse(this.raw.all(sql, JSON.stringify(params))) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: Params = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  /**
   * Ranked lexical retrieval across indexed facts and authored knowledge.
   * FTS syntax, ranking weights, and query bounds stay inside the native
   * storage owner rather than being reimplemented by each caller.
   */
  searchKnowledge(
    query: string,
    kinds: readonly KnowledgeKind[] = [],
    limit = 20,
    options: { memoryKind?: string } = {},
  ): KnowledgeHit[] {
    const rows = JSON.parse(
      this.raw.searchKnowledge(query, JSON.stringify(kinds), limit, options.memoryKind),
    ) as NativeKnowledgeHit[];
    return rows.map((row) => ({
      kind: row.kind,
      sourceId: row.source_id,
      title: row.title,
      path: row.path,
      symbol: row.symbol,
      updatedAt: row.updated_at,
      score: row.score,
      excerpt: row.excerpt,
    }));
  }

  /** Evidence-backed paths produced by bounded native framework adapters. */
  executionFlow(entryId?: string, maxPaths = 24, includeAssertions = false): ExecutionFlowView {
    return JSON.parse(
      this.raw.executionFlow(entryId, maxPaths, includeAssertions),
    ) as ExecutionFlowView;
  }

  /** Scalar helper for counts and aggregates. */
  count(sql: string, params: Params = []): number {
    const row = this.get<Record<string, unknown>>(sql, params);
    if (!row) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  lastInsertId(): number {
    return this.count("SELECT last_insert_rowid() AS id");
  }

  /** Re-attribute reference endpoints to stable declaration ids. */
  refreshReferenceIdentity(): void {
    const currentTypedGeneration = typedWorkspaceGeneration(this);
    this.run(
      `UPDATE refs SET
         src_symbol = (
           SELECT s.name FROM symbols s
           WHERE s.path = refs.src_path
             AND (s.start_line < refs.src_line OR
                  (s.start_line = refs.src_line AND s.start_column <= refs.src_column))
             AND (s.end_line > refs.src_line OR
                  (s.end_line = refs.src_line AND s.end_column >= refs.src_column))
           ORDER BY (s.end_line - s.start_line) ASC,
                    (s.end_column - s.start_column) ASC,
                    CASE s.kind WHEN 'method' THEN 0 WHEN 'function' THEN 1 ELSE 2 END,
                    s.start_line DESC LIMIT 1
         ),
         src_symbol_id = (
           SELECT s.id FROM symbols s
           WHERE s.path = refs.src_path
             AND (s.start_line < refs.src_line OR
                  (s.start_line = refs.src_line AND s.start_column <= refs.src_column))
             AND (s.end_line > refs.src_line OR
                  (s.end_line = refs.src_line AND s.end_column >= refs.src_column))
           ORDER BY (s.end_line - s.start_line) ASC,
                    (s.end_column - s.start_column) ASC,
                    CASE s.kind WHEN 'method' THEN 0 WHEN 'function' THEN 1 ELSE 2 END,
                    s.start_line DESC LIMIT 1
         )`,
    );
    this.run(
      `UPDATE refs SET dst_symbol_id = (
         SELECT s.id FROM symbols s
         WHERE s.path = refs.dst_path
           AND (s.name = refs.name OR (refs.name = 'default' AND s.default_export = 1))
           AND (refs.name = 'default' OR (
                (refs.dst_line IS NOT NULL OR
                 (SELECT COUNT(*) FROM symbols same
                   WHERE same.path = refs.dst_path AND same.name = refs.name) = 1)
                AND (refs.dst_line IS NULL OR
                 ((s.start_line < refs.dst_line OR
                   (s.start_line = refs.dst_line AND s.start_column <= refs.dst_column))
                  AND (s.end_line > refs.dst_line OR
                   (s.end_line = refs.dst_line AND s.end_column >= refs.dst_column))))
           ))
         ORDER BY
           s.exported DESC,
           (s.end_line - s.start_line) ASC,
           (s.end_column - s.start_column) ASC,
           s.start_line ASC
         LIMIT 1
        )`,
    );
    // Execution nodes retain the local callee spelling and exact source
    // occurrence. Resolve through that occurrence rather than comparing names:
    // import aliases intentionally use a different local and exported name.
    // Keeping this beside reference identity also makes compiler-pass updates
    // immediately visible without waiting for another repository scan.
    this.run(
      `UPDATE execution_nodes SET
         target_path = (
           SELECT r.dst_path FROM refs r
           WHERE r.src_path = execution_nodes.path
             AND r.src_line = execution_nodes.target_line
             AND r.src_column = execution_nodes.target_column
             AND r.dst_path IS NOT NULL
             AND r.dst_symbol_id IS NOT NULL
             AND ((r.specifier != ?1 AND r.specifier NOT LIKE ?2) OR EXISTS (
               SELECT 1 FROM files source
               WHERE source.path = r.src_path
                 AND source.ref_coverage = 'typed'
                 AND source.ref_generation = ?3
             ))
           LIMIT 1
         ),
         target_symbol = COALESCE((
           SELECT COALESCE(s.name, r.name)
           FROM refs r
           LEFT JOIN symbols s ON s.id = r.dst_symbol_id
           WHERE r.src_path = execution_nodes.path
             AND r.src_line = execution_nodes.target_line
             AND r.src_column = execution_nodes.target_column
             AND r.dst_path IS NOT NULL
             AND r.dst_symbol_id IS NOT NULL
             AND ((r.specifier != ?1 AND r.specifier NOT LIKE ?2) OR EXISTS (
               SELECT 1 FROM files source
               WHERE source.path = r.src_path
                 AND source.ref_coverage = 'typed'
                 AND source.ref_generation = ?3
             ))
           LIMIT 1
         ), execution_nodes.target_local)
       WHERE execution_nodes.target_local != ''`,
      [TYPED_SPECIFIER, `${TYPED_SPECIFIER}:%`, currentTypedGeneration],
    );
  }

  /**
   * Run a batch of writes atomically.
   *
   * The callback is deliberately synchronous: the engine shares one handle
   * per store across every request, so an `await` inside an open transaction
   * would let unrelated writes join it — and roll back with it on failure.
   * Do the reading and parsing first, then write in one synchronous pass.
   */
  transaction<T>(fn: () => T): T {
    this.run("BEGIN");
    try {
      const result = fn();
      this.run("COMMIT");
      return result;
    } catch (error) {
      try {
        this.run("ROLLBACK");
      } catch {
        // Nothing to roll back — the failure was BEGIN or COMMIT itself.
      }
      throw error;
    }
  }

  /** Compatibility boundary: native SQLite commits directly to disk. */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.raw.close();
  }
}

// The promise is cached, not the handle: two concurrent opens of one store
// would otherwise each build an in-memory copy of the same file, and the
// second flush would silently overwrite everything the first one wrote.
const open = new Map<string, Promise<Db>>();
const closing = new Map<string, Promise<boolean>>();
const lifecycle = new Map<string, Promise<unknown>>();

/**
 * Serialize every cache transition for one workspace.
 *
 * Waiting only for a known close is not sufficient: getDb() and closeDb()
 * both canonicalize their paths asynchronously, so either call can otherwise
 * reach the cache between another call's lookup, eviction, and replacement.
 * Holding this queue through open/close guarantees there is never more than
 * one live native connection for a workspace.
 */
function serializeLifecycle<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = lifecycle.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  lifecycle.set(key, current);
  void current.then(
    () => {
      if (lifecycle.get(key) === current) lifecycle.delete(key);
    },
    () => {
      if (lifecycle.get(key) === current) lifecycle.delete(key);
    },
  );
  return current;
}

/** Open (or reuse) the store for a project. */
export async function getDb(projectRoot: string): Promise<Db> {
  const canonical = await canonicalWorkspaceRoot(projectRoot);
  const key = workspaceIdentityKey(canonical);
  return serializeLifecycle(key, async () => {
    const existing = open.get(key);
    if (existing) return existing;
    const opening = Db.open(canonical);
    open.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      // A failed open must not poison the cache for every later call.
      if (open.get(key) === opening) open.delete(key);
      throw error;
    }
  });
}

/** Persist, evict and close one workspace store without disturbing others. */
export async function closeDb(projectRoot: string): Promise<boolean> {
  const canonical = await canonicalWorkspaceRoot(projectRoot);
  const key = workspaceIdentityKey(canonical);
  const alreadyClosing = closing.get(key);
  if (alreadyClosing) return alreadyClosing;

  const task = serializeLifecycle(key, async (): Promise<boolean> => {
    const pending = open.get(key);
    if (!pending) return false;
    // Block a new open for the next queued transition. Callers that already
    // hold this handle must be stopped by the daemon before it invokes closeDb.
    if (open.get(key) === pending) open.delete(key);

    const db = await pending;
    try {
      await db.flush();
    } finally {
      db.close();
    }
    return true;
  });
  closing.set(key, task);
  try {
    return await task;
  } finally {
    if (closing.get(key) === task) closing.delete(key);
  }
}

/** Open a store only when an index already exists on disk. */
export async function getExistingDb(projectRoot: string): Promise<Db> {
  const canonical = await canonicalWorkspaceRoot(projectRoot);
  const key = workspaceIdentityKey(canonical);
  const dbPath = databasePathForWorkspace(canonical);
  return serializeLifecycle(key, async () => {
    // App-owned storage can outlive a removed, unreadable, or replaced source
    // workspace. Do not present those retained facts as a readable workspace.
    const workspace = await stat(canonical);
    if (!workspace.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${canonical}`);
    }
    await access(canonical, constants.R_OK | constants.X_OK);

    const existing = open.get(key);
    if (existing) {
      await access(dbPath);
      return existing;
    }

    // Db.open(..., false) admits a legacy repository-local store so it can be
    // copied, then requires the app-owned database to exist. A missing store
    // can therefore never turn this read-only acquisition into a new empty one.
    const opening = Db.open(canonical, false);
    open.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      if (open.get(key) === opening) open.delete(key);
      throw error;
    }
  });
}

/** Drop the cached handles — used by tests. */
export async function resetDbCache(): Promise<void> {
  while (lifecycle.size > 0) {
    await Promise.allSettled([...lifecycle.values()]);
  }
  const pending = [...open.values()];
  open.clear();
  for (const db of await Promise.allSettled(pending)) {
    if (db.status === "fulfilled") db.value.close();
  }
}

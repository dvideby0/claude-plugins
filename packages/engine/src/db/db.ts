/**
 * SQLite access. One writer (this server), one file: sdlc-audit/audit.db.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadSqlJs, type SqlDatabase } from "../runtime/assets.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { canonicalWorkspaceRoot, workspaceIdentityKey } from "../lib/workspace-path.js";

export type Params = Array<string | number | null>;

export class Db {
  private constructor(
    private readonly raw: SqlDatabase,
    readonly path: string,
  ) {}

  static async open(projectRoot: string): Promise<Db> {
    const dbPath = join(projectRoot, "sdlc-audit", "audit.db");
    const SQL = await loadSqlJs();

    let raw: SqlDatabase;
    try {
      const bytes = await readFile(dbPath);
      raw = new SQL.Database(new Uint8Array(bytes));
    } catch {
      raw = new SQL.Database();
    }

    const db = new Db(raw, dbPath);

    // Migrate before the schema runs. `CREATE TABLE IF NOT EXISTS` does nothing
    // to a table that already exists, so a new column never appears on an
    // existing store — and an index over that column then fails to create,
    // which is how this was found. SCHEMA_VERSION was recorded but never read.
    db.migrate();

    db.raw.run(SCHEMA_SQL);
    db.refreshReferenceIdentity();
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('project_root', ?)", [
      projectRoot,
    ]);
    return db;
  }

  /** Columns every table must have, added to existing stores if absent. */
  private static readonly ADDED_COLUMNS: Array<{ table: string; column: string; type: string }> = [
    { table: "refs", column: "src_symbol", type: "TEXT" },
    { table: "refs", column: "src_column", type: "INTEGER NOT NULL DEFAULT 0" },
    { table: "refs", column: "src_symbol_id", type: "TEXT" },
    { table: "refs", column: "dst_line", type: "INTEGER" },
    { table: "refs", column: "dst_column", type: "INTEGER" },
    { table: "refs", column: "dst_symbol_id", type: "TEXT" },
    { table: "symbols", column: "default_export", type: "INTEGER NOT NULL DEFAULT 0" },
    { table: "symbols", column: "start_column", type: "INTEGER NOT NULL DEFAULT 0" },
    { table: "symbols", column: "end_column", type: "INTEGER NOT NULL DEFAULT 0" },
    { table: "files", column: "ref_coverage", type: "TEXT NOT NULL DEFAULT 'none'" },
    { table: "components", column: "member_digest", type: "TEXT" },
    { table: "flow_steps", column: "content_sha", type: "TEXT" },
  ];

  /**
   * Bring an existing store up to the current schema.
   *
   * Checked against the live table rather than a recorded version number: a
   * store that was half-upgraded, or written by a build that recorded the
   * version without applying the change, still converges. Adding a column is
   * the only migration shape supported on purpose — anything destructive
   * should be an explicit, reviewed change rather than something that happens
   * silently when a daemon starts.
   */
  private migrate(): void {
    for (const { table, column, type } of Db.ADDED_COLUMNS) {
      if (!this.tableExists(table)) continue;
      if (this.hasColumn(table, column)) continue;
      this.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private tableExists(table: string): boolean {
    return (
      this.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [
        table,
      ]) !== null
    );
  }

  private hasColumn(table: string, column: string): boolean {
    // PRAGMA takes no bound parameters, hence the interpolation; the table
    // names here are compile-time constants, never user input.
    return this.all<{ name: string }>(`PRAGMA table_info(${table})`).some(
      (row) => row.name === column,
    );
  }

  run(sql: string, params: Params = []): void {
    this.raw.run(sql, params);
  }

  all<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    const stmt = this.raw.prepare(sql);
    try {
      stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: Params = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
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
         WHERE s.path = refs.dst_path AND s.name = refs.name
           AND (refs.dst_line IS NULL OR
                ((s.start_line < refs.dst_line OR
                  (s.start_line = refs.dst_line AND s.start_column <= refs.dst_column))
                 AND (s.end_line > refs.dst_line OR
                  (s.end_line = refs.dst_line AND s.end_column >= refs.dst_column))))
         ORDER BY
           s.exported DESC,
           (s.end_line - s.start_line) ASC,
           (s.end_column - s.start_column) ASC,
           s.start_line ASC
         LIMIT 1
       )`,
    );
  }

  /**
   * Run a batch of writes atomically.
   *
   * The callback is deliberately synchronous: sql.js shares one handle per
   * store across every request, so an `await` inside an open transaction
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

  /** Flushes are chained: two overlapping exports share one tmp path. */
  private flushing: Promise<void> = Promise.resolve();

  /** Persist to disk atomically. */
  flush(): Promise<void> {
    this.flushing = this.flushing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, Buffer.from(this.raw.export()));
      await rename(tmp, this.path);
    });
    return this.flushing;
  }

  close(): void {
    this.raw.close();
  }
}

// The promise is cached, not the handle: two concurrent opens of one store
// would otherwise each build an in-memory copy of the same file, and the
// second flush would silently overwrite everything the first one wrote.
const open = new Map<string, Promise<Db>>();

/** Open (or reuse) the store for a project. */
export async function getDb(projectRoot: string): Promise<Db> {
  const canonical = await canonicalWorkspaceRoot(projectRoot);
  const key = workspaceIdentityKey(canonical);
  const existing = open.get(key);
  if (existing) return existing;
  const opening = Db.open(canonical);
  open.set(key, opening);
  // A failed open must not poison the cache for every later call.
  opening.catch(() => open.delete(key));
  return opening;
}

/** Drop the cached handles — used by tests. */
export async function resetDbCache(): Promise<void> {
  const pending = [...open.values()];
  open.clear();
  for (const db of await Promise.allSettled(pending)) {
    if (db.status === "fulfilled") db.value.close();
  }
}

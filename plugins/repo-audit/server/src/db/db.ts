/**
 * SQLite access. One writer (this server), one file: sdlc-audit/audit.db.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadSqlJs, type SqlDatabase } from "../runtime/vendor.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

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
    db.raw.run(SCHEMA_SQL);
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('project_root', ?)", [
      projectRoot,
    ]);
    return db;
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

  /** Persist to disk atomically. */
  async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, Buffer.from(this.raw.export()));
    await rename(tmp, this.path);
  }

  close(): void {
    this.raw.close();
  }
}

const open = new Map<string, Db>();

/** Open (or reuse) the store for a project. */
export async function getDb(projectRoot: string): Promise<Db> {
  const existing = open.get(projectRoot);
  if (existing) return existing;
  const db = await Db.open(projectRoot);
  open.set(projectRoot, db);
  return db;
}

/** Drop the cached handle — used by tests. */
export function resetDbCache(): void {
  for (const db of open.values()) db.close();
  open.clear();
}

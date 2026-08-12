/**
 * Loads the SQLite WASM runtime straight from node_modules.
 *
 * The engine is installed by the desktop app, so its dependencies are always
 * present — nothing here is vendored, copied or committed.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Directory holding sql-wasm.js and sql-wasm.wasm. */
function sqlJsDir(): string {
  return dirname(require.resolve("sql.js"));
}

// --- SQLite (sql.js) -------------------------------------------------------

export interface SqlStatement {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

export interface SqlDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): SqlStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlDatabase;
}

let sqlJs: SqlJsStatic | null = null;

export async function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJs) return sqlJs;
  const dir = sqlJsDir();
  const initSqlJs = require(join(dir, "sql-wasm.js")) as (
    config: { locateFile: (file: string) => string },
  ) => Promise<SqlJsStatic>;
  sqlJs = await initSqlJs({ locateFile: (file: string) => join(dir, file) });
  return sqlJs;
}

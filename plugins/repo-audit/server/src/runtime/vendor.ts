/**
 * Loads the vendored wasm runtimes (SQLite + tree-sitter) that ship with the
 * plugin. Nothing here touches the network or requires an npm install.
 */

import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

let vendorDirCache: string | null = null;

/** Walk up from this module until a directory containing vendor/ is found. */
export async function vendorDir(): Promise<string> {
  if (vendorDirCache) return vendorDirCache;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "vendor");
    try {
      await access(join(candidate, "sql-wasm.wasm"));
      vendorDirCache = candidate;
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(
    "vendor/ not found — run `npm run dist` in the plugin's server directory",
  );
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
  const dir = await vendorDir();
  const initSqlJs = require(join(dir, "sql-wasm.cjs")) as (
    config: { locateFile: (file: string) => string },
  ) => Promise<SqlJsStatic>;
  sqlJs = await initSqlJs({ locateFile: (file: string) => join(dir, file) });
  return sqlJs;
}

// --- tree-sitter -----------------------------------------------------------

export interface TsNode {
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: TsNode | null;
  type: string;
  childForFieldName(field: string): TsNode | null;
}

export interface TsQuery {
  captures(node: TsNode): Array<{ name: string; node: TsNode }>;
}

export interface TsLanguage {
  readonly __brand: unique symbol;
}

export interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: TsNode } | null;
}

interface TreeSitterModule {
  Parser: {
    new (): TsParser;
    init(config: { locateFile: (file: string) => string }): Promise<void>;
  };
  Query: new (language: unknown, source: string) => TsQuery;
  Language: { load(path: string): Promise<unknown> };
}

export type GrammarName = "typescript" | "tsx" | "python";

interface TreeSitterRuntime {
  parser: TsParser;
  Query: TreeSitterModule["Query"];
  grammars: Record<GrammarName, unknown>;
}

let treeSitter: TreeSitterRuntime | null = null;

export async function loadTreeSitter(): Promise<TreeSitterRuntime> {
  if (treeSitter) return treeSitter;

  const dir = await vendorDir();
  const mod = require(join(dir, "tree-sitter.cjs")) as TreeSitterModule;
  await mod.Parser.init({ locateFile: (file: string) => join(dir, file) });

  const names: GrammarName[] = ["typescript", "tsx", "python"];
  const loaded = await Promise.all(
    names.map((name) => mod.Language.load(join(dir, `tree-sitter-${name}.wasm`))),
  );

  treeSitter = {
    parser: new mod.Parser(),
    Query: mod.Query,
    grammars: {
      typescript: loaded[0],
      tsx: loaded[1],
      python: loaded[2],
    },
  };
  return treeSitter;
}

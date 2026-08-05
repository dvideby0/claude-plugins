/**
 * Loads the wasm runtimes (SQLite + tree-sitter) straight from node_modules.
 *
 * The engine is installed by the desktop app, so its dependencies are always
 * present — nothing here is vendored, copied or committed.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Directory holding tree-sitter.js and the grammar wasm files. */
function treeSitterDir(): string {
  return dirname(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js"));
}

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

// --- tree-sitter -----------------------------------------------------------

export interface TsNode {
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: TsNode | null;
  type: string;
  namedChildren: TsNode[];
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

  const dir = treeSitterDir();
  const mod = require(join(dir, "tree-sitter.js")) as TreeSitterModule;
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

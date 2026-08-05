import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { loadSqlJs } from "../runtime/assets.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("database migrations", () => {
  it("rebuilds the legacy refs key with source-column occurrence identity", async () => {
    root = await makeProject({ "package.json": "{}" });
    const SQL = await loadSqlJs();
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE refs (
      src_path TEXT NOT NULL,
      src_line INTEGER NOT NULL,
      src_column INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      specifier TEXT NOT NULL,
      dst_path TEXT,
      src_symbol TEXT,
      src_symbol_id TEXT,
      dst_line INTEGER,
      dst_column INTEGER,
      dst_symbol_id TEXT,
      PRIMARY KEY (src_path, src_line, name, specifier)
    )`);
    legacy.run(
      "INSERT INTO refs(src_path, src_line, src_column, name, specifier) VALUES('src/app.ts', 1, 4, 'run', 'typed:x')",
    );
    await mkdir(join(root, "sdlc-audit"), { recursive: true });
    await writeFile(join(root, "sdlc-audit", "audit.db"), Buffer.from(legacy.export()));
    legacy.close();

    const db = await getDb(root);
    const primaryKey = db
      .all<{ name: string; pk: number }>("PRAGMA table_info(refs)")
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    expect(primaryKey).toEqual(["src_path", "src_line", "src_column", "name", "specifier"]);

    db.run(
      "INSERT INTO refs(src_path, src_line, src_column, name, specifier) VALUES('src/app.ts', 1, 18, 'run', 'typed:x')",
    );
    expect(db.count("SELECT COUNT(*) AS n FROM refs")).toBe(2);
  });
});

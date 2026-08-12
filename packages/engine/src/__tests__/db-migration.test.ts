import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { NativeDatabase } from "@sdlc/scan-core";
import { getDb, getExistingDb, resetDbCache } from "../db/db.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("database migrations", () => {
  it("does not cache a blank store while an existing index is unavailable", async () => {
    root = await makeProject({ "package.json": "{}" });
    const db = await getDb(root);
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('sentinel', 'kept')");
    const path = db.path;
    expect(path.startsWith(root)).toBe(false);
    await expect(access(join(root, "sdlc-audit", "audit.db"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await resetDbCache();

    const offline = `${path}.offline`;
    await rename(path, offline);
    await expect(getExistingDb(root)).rejects.toMatchObject({ code: "ENOENT" });
    await rename(offline, path);

    const reopened = await getExistingDb(root);
    expect(reopened.get<{ value: string }>("SELECT value FROM meta WHERE key = 'sentinel'")?.value)
      .toBe("kept");
  });

  it("rebuilds the legacy refs key with source-column occurrence identity", async () => {
    root = await makeProject({ "package.json": "{}" });
    const legacyPath = join(root, "sdlc-audit", "audit.db");
    await mkdir(join(root, "sdlc-audit"), { recursive: true });
    const legacy = new NativeDatabase(legacyPath, true);
    legacy.executeBatch(`CREATE TABLE refs (
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
      "[]",
    );
    legacy.close();

    // Status and cross-workspace reads use getExistingDb; they must perform
    // the one-time legacy copy without manufacturing an empty store.
    const db = await getExistingDb(root);
    expect(db.path).not.toBe(legacyPath);
    await expect(access(legacyPath)).resolves.toBeUndefined();
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

  it("adds per-file compiler generation attestations to existing stores", async () => {
    root = await makeProject({ "package.json": "{}" });
    const legacyPath = join(root, "sdlc-audit", "audit.db");
    await mkdir(join(root, "sdlc-audit"), { recursive: true });
    const legacy = new NativeDatabase(legacyPath, true);
    legacy.executeBatch(`CREATE TABLE files (
      path TEXT PRIMARY KEY,
      lang TEXT NOT NULL,
      loc INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      content_sha TEXT NOT NULL,
      churn INTEGER NOT NULL DEFAULT 0,
      is_test INTEGER NOT NULL DEFAULT 0,
      parsed INTEGER NOT NULL DEFAULT 0,
      ref_coverage TEXT NOT NULL DEFAULT 'none',
      present INTEGER NOT NULL DEFAULT 1,
      first_seen_run INTEGER,
      last_seen_run INTEGER
    )`);
    legacy.run(
      "INSERT INTO files(path, lang, content_sha, ref_coverage) VALUES('src/app.ts', 'typescript', 'abc', 'typed')",
      "[]",
    );
    legacy.close();

    const db = await getDb(root);
    expect(
      db.all<{ name: string }>("PRAGMA table_info(files)").some(
        (column) => column.name === "ref_generation",
      ),
    ).toBe(true);
    expect(
      db.all<{ name: string }>("PRAGMA table_info(files)").some(
        (column) => column.name === "ref_source_signature",
      ),
    ).toBe(true);
    expect(
      db.get<{ ref_generation: string | null }>(
        "SELECT ref_generation FROM files WHERE path = 'src/app.ts'",
      )?.ref_generation,
    ).toBeNull();
    expect(
      db.get<{ ref_source_signature: string | null }>(
        "SELECT ref_source_signature FROM files WHERE path = 'src/app.ts'",
      )?.ref_source_signature,
    ).toBeNull();
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value)
      .toBe(String(SCHEMA_VERSION));
  });
});

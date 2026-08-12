import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { databaseSchemaVersion, NativeDatabase } from "@sdlc/scan-core";
import {
  databasePathForWorkspace,
  getDb,
  getExistingDb,
  resetDbCache,
} from "../db/db.js";
import { canonicalWorkspaceRoot } from "../lib/workspace-path.js";
import { cleanup, makeProject } from "./helpers.js";

const SCHEMA_VERSION = databaseSchemaVersion();
let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("database migrations", () => {
  it("runs the Rust-owned migration lifecycle off the Node event loop", async () => {
    root = await makeProject({ "package.json": "{}" });
    const dbPath = join(root, "async-migration.db");
    const native = new NativeDatabase(dbPath, true);
    try {
      const migration = native.migrate(root, join(root, "backups"));
      expect(migration).toBeInstanceOf(Promise);
      await migration;
      expect(JSON.parse(native.all("PRAGMA user_version", "[]"))).toEqual([
        { user_version: SCHEMA_VERSION },
      ]);
    } finally {
      native.close();
    }
  });

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
    expect(db.count("PRAGMA user_version")).toBe(SCHEMA_VERSION);

    const migration = db.get<{
      from_version: number;
      backup_path: string | null;
    }>("SELECT from_version, backup_path FROM schema_migrations WHERE version = ?", [
      SCHEMA_VERSION,
    ]);
    expect(migration).toMatchObject({ from_version: 0 });
    expect(dirname(migration?.backup_path ?? "")).toBe(join(dirname(db.path), "backups"));
    expect(basename(migration?.backup_path ?? "")).toMatch(
      new RegExp(`^pre-v${SCHEMA_VERSION}-\\d+\\.db$`),
    );
    await expect(access(migration?.backup_path ?? "")).resolves.toBeUndefined();
    expect(await readdir(dirname(migration?.backup_path ?? ""))).toEqual([
      basename(migration?.backup_path ?? ""),
    ]);

    const backup = new NativeDatabase(migration?.backup_path ?? "", false);
    try {
      expect(JSON.parse(backup.all("PRAGMA journal_mode", "[]"))).toEqual([
        { journal_mode: "delete" },
      ]);
      expect(JSON.parse(backup.all("PRAGMA quick_check", "[]"))).toEqual([
        { quick_check: "ok" },
      ]);
      expect(JSON.parse(backup.all("SELECT path FROM files", "[]"))).toEqual([
        { path: "src/app.ts" },
      ]);
      expect(JSON.parse(backup.all("PRAGMA user_version", "[]"))).toEqual([
        { user_version: 0 },
      ]);
    } finally {
      backup.close();
    }
  });

  it("rolls back a failed migration and retains a consistent recovery image", async () => {
    root = await makeProject({ "package.json": "{}" });
    const legacyPath = join(root, "sdlc-audit", "audit.db");
    await mkdir(dirname(legacyPath), { recursive: true });
    const legacy = new NativeDatabase(legacyPath, true);
    legacy.executeBatch(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES('schema_version', '16');
      CREATE TABLE sentinel(value TEXT NOT NULL);
      INSERT INTO sentinel(value) VALUES('preserved');
      CREATE VIEW schema_migrations AS SELECT 999 AS version;
      PRAGMA user_version = 16;
    `);
    legacy.close();

    await expect(getDb(root)).rejects.toThrow(/pre-migration recovery image/);

    const dbPath = databasePathForWorkspace(await canonicalWorkspaceRoot(root));
    const backupDir = join(dirname(dbPath), "backups");
    const backupNames = await readdir(backupDir);
    expect(backupNames).toHaveLength(1);
    expect(backupNames[0]).toMatch(new RegExp(`^pre-v${SCHEMA_VERSION}-\\d+\\.db$`));
    const firstBackupName = backupNames[0] ?? "";
    const backupPath = join(backupDir, firstBackupName);
    const failed = new NativeDatabase(dbPath, false);
    try {
      expect(JSON.parse(failed.all("SELECT value FROM sentinel", "[]"))).toEqual([
        { value: "preserved" },
      ]);
      expect(JSON.parse(failed.all("PRAGMA user_version", "[]"))).toEqual([
        { user_version: 16 },
      ]);
      expect(
        JSON.parse(
          failed.all(
            "SELECT type FROM sqlite_schema WHERE name = 'schema_migrations'",
            "[]",
          ),
        ),
      ).toEqual([{ type: "view" }]);
    } finally {
      failed.close();
    }

    const backup = new NativeDatabase(backupPath, false);
    try {
      expect(JSON.parse(backup.all("PRAGMA quick_check", "[]"))).toEqual([
        { quick_check: "ok" },
      ]);
      expect(JSON.parse(backup.all("SELECT value FROM sentinel", "[]"))).toEqual([
        { value: "preserved" },
      ]);
    } finally {
      backup.close();
    }

    await expect(getDb(root)).rejects.toThrow(/pre-migration recovery image/);
    const retriedBackupNames = await readdir(backupDir);
    expect(retriedBackupNames).toHaveLength(1);
    expect(retriedBackupNames[0]).toMatch(
      new RegExp(`^pre-v${SCHEMA_VERSION}-\\d+\\.db$`),
    );
    expect(retriedBackupNames[0]).not.toBe(firstBackupName);
  });

  it("refuses a newer schema without configuring or backing up the store", async () => {
    root = await makeProject({ "package.json": "{}" });
    const legacyPath = join(root, "sdlc-audit", "audit.db");
    await mkdir(dirname(legacyPath), { recursive: true });
    const future = new NativeDatabase(legacyPath, true);
    future.executeBatch(`
      CREATE TABLE sentinel(value TEXT NOT NULL);
      INSERT INTO sentinel(value) VALUES('future-data');
      PRAGMA user_version = ${SCHEMA_VERSION + 1};
    `);
    future.close();
    const original = await readFile(legacyPath);

    await expect(getDb(root)).rejects.toThrow(
      `supports v${SCHEMA_VERSION}`,
    );

    const dbPath = databasePathForWorkspace(await canonicalWorkspaceRoot(root));
    expect(await readFile(dbPath)).toEqual(original);
    await expect(access(join(dirname(dbPath), "backups"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an unrecorded current schema without configuring the store", async () => {
    root = await makeProject({ "package.json": "{}" });
    const legacyPath = join(root, "sdlc-audit", "audit.db");
    await mkdir(dirname(legacyPath), { recursive: true });
    const unrecorded = new NativeDatabase(legacyPath, true);
    unrecorded.executeBatch(`
      CREATE TABLE sentinel(value TEXT NOT NULL);
      INSERT INTO sentinel(value) VALUES('unrecorded');
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    unrecorded.close();
    const original = await readFile(legacyPath);

    await expect(getDb(root)).rejects.toThrow("missing its migration ledger");

    const dbPath = databasePathForWorkspace(await canonicalWorkspaceRoot(root));
    expect(await readFile(dbPath)).toEqual(original);
    await expect(access(join(dirname(dbPath), "backups"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

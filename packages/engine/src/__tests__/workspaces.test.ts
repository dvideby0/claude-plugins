import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceRegistry } from "../daemon/workspaces.js";
import { closeDb, getDb } from "../db/db.js";
import { canonicalWorkspaceRoot } from "../lib/workspace-path.js";
import { crossQuery } from "../graph/cross.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("workspace identity", () => {
  it("maps a symlink and its target to one registry id and one database handle", async () => {
    root = await makeProject({
      "real/package.json": JSON.stringify({ name: "canonical-fixture" }),
    });
    const real = join(root, "real");
    const alias = join(root, "alias");
    await symlink(real, alias, "dir");

    expect(await canonicalWorkspaceRoot(alias)).toBe(await canonicalWorkspaceRoot(real));

    const registry = new WorkspaceRegistry(join(root, "workspaces.json"));
    const first = await registry.add(real);
    const second = await registry.add(alias);
    expect(second.id).toBe(first.id);
    expect(await registry.list()).toHaveLength(1);
    expect(first.generation).toBe(0);

    await registry.markIndexed(real);
    expect((await registry.get(first.id))?.generation).toBe(1);
    await registry.markUpdated(alias);
    expect((await registry.get(first.id))?.generation).toBe(2);

    const [realDb, aliasDb] = await Promise.all([getDb(real), getDb(alias)]);
    expect(aliasDb).toBe(realDb);
  });

  it("reports missing and corrupt cross-workspace indexes as unreadable", async () => {
    root = await makeProject({
      "indexed/package.json": JSON.stringify({ name: "indexed" }),
      "indexed/src/value.ts": "export const needle = 1;\n",
      "missing/package.json": JSON.stringify({ name: "missing" }),
      "corrupt/package.json": JSON.stringify({ name: "corrupt" }),
    });
    const indexed = join(root, "indexed");
    const missing = join(root, "missing");
    const corrupt = join(root, "corrupt");
    await scan(indexed, { kind: "full" });
    await mkdir(join(corrupt, "sdlc-audit"), { recursive: true });
    await writeFile(join(corrupt, "sdlc-audit", "audit.db"), "not a sqlite database");

    const result = await crossQuery(
      [
        { id: "indexed", name: "indexed", root: indexed },
        { id: "missing", name: "missing", root: missing },
        { id: "corrupt", name: "corrupt", root: corrupt },
      ],
      "symbol",
      "needle",
    );

    expect(result.hits).toEqual([
      expect.objectContaining({
        workspace: "indexed",
        detail: expect.objectContaining({ name: "needle" }),
      }),
    ]);
    expect(result.unreadable.sort()).toEqual(["corrupt", "missing"]);
  });

  it("does not expose an uncached store while its workspace is unavailable", async () => {
    root = await makeProject({
      "offline/package.json": JSON.stringify({ name: "offline" }),
      "offline/src/value.ts": "export const retainedNeedle = 1;\n",
    });
    const offline = join(root, "offline");
    await scan(offline, { kind: "full" });
    await closeDb(offline);
    await rm(offline, { recursive: true, force: true });

    const result = await crossQuery(
      [{ id: "offline", name: "offline", root: offline }],
      "symbol",
      "retainedNeedle",
    );

    expect(result.hits).toEqual([]);
    expect(result.unreadable).toEqual(["offline"]);
  });

  it("persists and evicts a removed workspace database handle", async () => {
    root = await makeProject({
      "project/package.json": JSON.stringify({ name: "evicted" }),
    });
    const project = join(root, "project");
    const first = await getDb(project);
    first.run("INSERT OR REPLACE INTO meta(key, value) VALUES('eviction-test', 'preserved')");

    expect(await closeDb(project)).toBe(true);
    expect(() => first.count("SELECT COUNT(*) AS n FROM meta")).toThrow();

    const reopened = await getDb(project);
    expect(reopened).not.toBe(first);
    expect(
      reopened.get<{ value: string }>("SELECT value FROM meta WHERE key = 'eviction-test'")?.value,
    ).toBe("preserved");
  });

  it("does not open a second image when acquisition races eviction", async () => {
    root = await makeProject({
      "project/package.json": JSON.stringify({ name: "close-race" }),
    });
    const project = join(root, "project");
    const first = await getDb(project);
    first.run("INSERT OR REPLACE INTO meta(key, value) VALUES('close-race', 'preserved')");

    // Acquisition starts first. An unconditional `await undefined` in getDb
    // used to let the close evict `first` before the cache lookup resumed,
    // creating a second live SQLite connection over the same audit.db.
    const acquiring = getDb(project);
    const closing = closeDb(project);
    const acquired = await acquiring;
    expect(await closing).toBe(true);

    // Canonicalization may order the close first, in which case `acquired` is
    // the safely reopened image. If acquisition wins it is the old (now
    // closed) handle. Either ordering is valid; the live image must contain
    // the state eviction flushed before any replacement was opened.
    const live = acquired === first ? await getDb(project) : acquired;
    expect(
      live.get<{ value: string }>("SELECT value FROM meta WHERE key = 'close-race'")?.value,
    ).toBe("preserved");
    expect(await getDb(project)).toBe(live);
  });

  it("surfaces a corrupt registry without overwriting it", async () => {
    root = await makeProject({ "package.json": JSON.stringify({ name: "registry-corruption" }) });
    const path = join(root, "workspaces.json");
    const corrupt = "{ this is not valid json";
    await writeFile(path, corrupt);
    const registry = new WorkspaceRegistry(path);

    await expect(registry.list()).rejects.toThrow();
    await expect(registry.add(root)).rejects.toThrow();
    expect(await readFile(path, "utf-8")).toBe(corrupt);
  });
});

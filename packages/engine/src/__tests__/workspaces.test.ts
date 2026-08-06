import { afterEach, describe, expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceRegistry } from "../daemon/workspaces.js";
import { getDb } from "../db/db.js";
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
});

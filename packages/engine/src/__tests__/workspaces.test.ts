import { afterEach, describe, expect, it } from "vitest";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceRegistry } from "../daemon/workspaces.js";
import { getDb } from "../db/db.js";
import { canonicalWorkspaceRoot } from "../lib/workspace-path.js";
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

    const [realDb, aliasDb] = await Promise.all([getDb(real), getDb(alias)]);
    expect(aliasDb).toBe(realDb);
  });
});

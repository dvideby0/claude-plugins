import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { findTsConfigs } from "../analyze/tools.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const config = JSON.stringify({ files: ["index.ts"] });

describe("TypeScript project discovery", () => {
  it("keeps discovering nested projects after finding a root config", async () => {
    root = await makeProject({
      "tsconfig.json": config,
      "index.ts": "export {};",
      "packages/api/tsconfig.json": config,
      "packages/api/index.ts": "export {};",
      "unusual/nested/tool/tsconfig.json": config,
      "unusual/nested/tool/index.ts": "export {};",
      "node_modules/ignored/tsconfig.json": config,
      "node_modules/ignored/index.ts": "export {};",
    });

    const result = await findTsConfigs(root);
    expect(result.capped).toBe(false);
    expect(result.roots).toEqual([
      root,
      join(root, "packages", "api"),
      join(root, "unusual", "nested", "tool"),
    ]);
  });

  it("marks discovery partial instead of reporting an unchecked clean run", async () => {
    root = await makeProject({
      "a/tsconfig.json": config,
      "a/index.ts": "export {};",
      "b/tsconfig.json": config,
      "b/index.ts": "export {};",
      "c/tsconfig.json": config,
      "c/index.ts": "export {};",
    });

    const result = await findTsConfigs(root, 2);
    expect(result.roots).toHaveLength(2);
    expect(result.capped).toBe(true);
  });
});

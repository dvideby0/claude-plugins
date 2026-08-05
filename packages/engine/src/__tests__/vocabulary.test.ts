import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { buildBrief } from "../graph/brief.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/types.ts": `
export const LEVELS = ["debug", "info", "warn", "error"] as const;
export const KINDS = [
  "alpha",
  "beta",
] as const;
const PRIVATE_ONLY = ["hidden"] as const;
export const helper = () => 1;
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("exported vocabulary", () => {
  it("records exported constants with their values", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const levels = db.get<{ signature: string; exported: number; kind: string }>(
      "SELECT signature, exported, kind FROM symbols WHERE name = 'LEVELS'",
    );
    expect(levels?.kind).toBe("constant");
    expect(levels?.exported).toBe(1);
    // The allowed values are the point — without them a caller invents one.
    expect(levels?.signature).toContain('"warn"');
    expect(levels?.signature).toContain('"error"');
  });

  it("keeps the values of a constant written across several lines", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const kinds = db.get<{ signature: string }>(
      "SELECT signature FROM symbols WHERE name = 'KINDS'",
    );
    expect(kinds?.signature).toContain('"alpha"');
    expect(kinds?.signature).toContain('"beta"');
  });

  it("marks exported arrow functions as exported", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    // `export const x = () => {}` nests one level deeper than a function
    // declaration; a fixed-depth check marked every one of these private.
    const helper = db.get<{ exported: number }>(
      "SELECT exported FROM symbols WHERE name = 'helper'",
    );
    expect(helper?.exported).toBe(1);
  });

  it("leaves unexported constants out", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(db.count("SELECT COUNT(*) AS n FROM symbols WHERE name = 'PRIVATE_ONLY'")).toBe(0);
  });

  it("puts the allowed values in the brief", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const brief = buildBrief(db, "src/types.ts");
    expect(brief.text).toContain('"warn"');
  });
});

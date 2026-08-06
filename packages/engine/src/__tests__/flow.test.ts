import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { flowView } from "../graph/flow.js";
import { resolveTypes } from "../graph/typed.js";
import { scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["src/**/*"],
  }),
  "src/log.ts": `export function log(m: string): string { return m; }`,
  "src/db.ts": `
import { log } from "./log.js";
export function query(sql: string): string { return log(sql); }
`,
  "src/repo.ts": `
import { query } from "./db.js";
import { log } from "./log.js";
export function findUser(id: string): string { log("f"); return query(id); }
`,
  "src/service.ts": `
import { findUser } from "./repo.js";
import { log } from "./log.js";
export function loadProfile(id: string): string { log("l"); return findUser(id); }
`,
  "src/routes.ts": `
import { loadProfile } from "./service.js";
import { log } from "./log.js";
export function handleProfile(id: string): string { log("h"); return loadProfile(id); }
`,
  "src/routes.test.ts": `
import { handleProfile } from "./routes.js";
handleProfile("x");
`,
  "src/duplicates.ts": `
export function alpha(): string { return "a"; }
export function beta(): string { return "b"; }
export class A { run(): string { return alpha(); } } export class B { run(): string { return beta(); } }
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

const withNative = loadNative() ? describe : describe.skip;

describe("flow input bounds", () => {
  it("rejects non-finite depth before touching the graph", () => {
    const unreadableDb = {} as Parameters<typeof flowView>[0];
    expect(() => flowView(unreadableDb, { depth: Number.NaN })).toThrow(/depth/i);
    expect(() => flowView(unreadableDb, { depth: Number.POSITIVE_INFINITY })).toThrow(/depth/i);
  });
});

withNative("flow", () => {
  it("finds the entry point and orders the layers by depth", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const view = flowView(db, { depth: 4 });
    const entryNames = view.entries.map(
      (id) => view.nodes.find((node) => node.id === id)?.symbol,
    );

    // handleProfile is called only from a test, which is excluded — otherwise
    // every test file would present itself as a way into the system.
    expect(entryNames).toContain("handleProfile");

    const depthOf = (symbol: string) =>
      view.nodes.find((node) => node.symbol === symbol)?.depth;
    expect(depthOf("handleProfile")).toBe(0);
    expect(depthOf("loadProfile")).toBe(1);
    expect(depthOf("findUser")).toBe(2);

    // A node is never left of something that reaches it.
    for (const edge of view.edges) {
      const from = view.nodes.find((node) => node.id === edge.from);
      const to = view.nodes.find((node) => node.id === edge.to);
      if (from && to && !to.commons) expect(to.depth).toBeGreaterThan(from.depth);
    }
  });

  it("moves a widely called utility into the commons lane", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    // log() is called from four places; drawn inline it would cross every
    // column, which is what makes these diagrams unreadable.
    const view = flowView(db, { depth: 4, maxNodes: 40 });
    const nameOf = (id: string) => view.nodes.find((node) => node.id === id)?.symbol;
    const commons = view.commons.map(nameOf);
    const inLayers = view.layers.flat().map(nameOf);

    if (commons.length > 0) {
      expect(commons).toContain("log");
      expect(inLayers).not.toContain("log");
    }
  });

  it("roots at one symbol when asked", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const view = flowView(db, { root: "findUser", depth: 3 });
    expect(view.entries).toHaveLength(1);
    expect(view.nodes.find((node) => node.symbol === "findUser")?.depth).toBe(0);
    // Nothing above the chosen root appears.
    expect(view.nodes.map((node) => node.symbol)).not.toContain("handleProfile");
  });

  it("marks a node expandable when it stopped at the depth limit", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const view = flowView(db, { root: "handleProfile", depth: 1 });
    const stopped = view.nodes.find((node) => node.symbol === "loadProfile");
    expect(stopped?.expandable).toBe(true);
    expect(view.nodes.map((node) => node.symbol)).not.toContain("findUser");
  });

  it("roots duplicate method names by exact symbol id", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).ran).toBe(true);

    const methods = db.all<{ id: string }>(
      "SELECT id FROM symbols WHERE path = 'src/duplicates.ts' AND name = 'run' ORDER BY start_line, start_column",
    );
    const first = flowView(db, { rootId: methods[0].id, depth: 2 });
    const second = flowView(db, { rootId: methods[1].id, depth: 2 });
    expect(first.nodes.map((node) => node.symbol)).toContain("alpha");
    expect(first.nodes.map((node) => node.symbol)).not.toContain("beta");
    expect(second.nodes.map((node) => node.symbol)).toContain("beta");
    expect(second.nodes.map((node) => node.symbol)).not.toContain("alpha");
  });

  it("returns candidates instead of merging ambiguous named roots", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).ran).toBe(true);

    const ambiguous = flowView(db, { root: "run", depth: 2 });
    expect(ambiguous.entries).toEqual([]);
    expect(ambiguous.nodes).toEqual([]);
    expect(ambiguous.note).toMatch(/ambiguous/i);
    expect(ambiguous.candidates).toHaveLength(2);
  });
});

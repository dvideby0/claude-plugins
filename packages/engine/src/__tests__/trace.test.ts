import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { resolveTypes } from "../graph/typed.js";
import { trace } from "../graph/trace.js";
import { scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { cleanup, makeProject } from "./helpers.js";

/** A request path, the thing "trace this endpoint" is actually asking about. */
const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["src/**/*"],
  }),
  "src/db.ts": `
export function query(sql: string): string { return sql; }
`,
  "src/repo.ts": `
import { query } from "./db.js";
export function findUser(id: string): string { return query("select " + id); }
export function countUsers(): string { return query("count"); }
`,
  "src/service.ts": `
import { findUser } from "./repo.js";
export function loadProfile(id: string): string { return findUser(id); }
`,
  "src/routes.ts": `
import { loadProfile } from "./service.js";
export function handleGetProfile(id: string): string { return loadProfile(id); }
export function handleHealth(): string { return "ok"; }
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

const withNative = loadNative() ? describe : describe.skip;

withNative("call chains", () => {
  it("follows a request path through the layers", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const result = trace(db, "handleGetProfile", { direction: "callees", depth: 4 });
    expect(result.rootPath).toBe("src/routes.ts");

    const reached = result.nodes.map((node) => node.symbol);
    expect(reached).toContain("loadProfile");
    expect(reached).toContain("findUser");
    expect(reached).toContain("query");

    // The chain is ordered, which is the whole point — imports would say only
    // that routes.ts can see service.ts.
    const chain = result.chains.find((text) => text.includes("query"));
    expect(chain).toBeDefined();
    const order = ["handleGetProfile", "loadProfile", "findUser", "query"].map((name) =>
      chain?.indexOf(name),
    );
    expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));

    // A sibling route that reaches none of it must not appear.
    expect(reached).not.toContain("handleHealth");
  });

  it("walks the other way, from a leaf back to its entry points", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const callers = trace(db, "query", { direction: "callers", depth: 4 });
    const reached = callers.nodes.map((node) => node.symbol);

    expect(reached).toContain("findUser");
    expect(reached).toContain("countUsers");
    expect(reached).toContain("loadProfile");
    expect(reached).toContain("handleGetProfile");
  });

  it("respects the depth limit and says where it stopped", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const shallow = trace(db, "handleGetProfile", { direction: "callees", depth: 1 });
    expect(shallow.nodes.map((n) => n.symbol)).toContain("loadProfile");
    expect(shallow.nodes.map((n) => n.symbol)).not.toContain("query");
    expect(shallow.nodes.some((node) => node.truncated)).toBe(true);
  });

  it("attributes references to the enclosing symbol", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    // Without this column a ref says where a call happens but not who makes
    // it, and no chain can be walked.
    const row = db.get<{ src_symbol: string }>(
      "SELECT src_symbol FROM refs WHERE name = 'loadProfile' AND src_path = 'src/routes.ts'",
    );
    expect(row?.src_symbol).toBe("handleGetProfile");
  });

  it("keeps working after the typed pass rewrites the rows", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(resolveTypes(db, root).ran).toBe(true);

    const result = trace(db, "handleGetProfile", { direction: "callees", depth: 4 });
    expect(result.nodes.map((node) => node.symbol)).toContain("query");
  });

  it("returns nothing for an unknown symbol rather than guessing", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const result = trace(db, "noSuchThing");
    expect(result.rootPath).toBeNull();
    expect(result.nodes).toHaveLength(0);
  });
});

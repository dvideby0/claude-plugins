import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDb } from "../db/db.js";
import { createMcpServer } from "../mcp/server.js";
import { resolveTypes } from "../graph/typed.js";
import { relate } from "../graph/relations.js";
import { scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { cleanup, makeProject } from "./helpers.js";

const withNative = loadNative() ? describe : describe.skip;

const PROJECT = {
  "package.json": JSON.stringify({ name: "http-flow", version: "1.0.0", type: "module" }),
  "src/search.ts": `
export function normalizeSearchQuery(value: string): string {
  if (!value) throw new Error("empty");
  return value.trim();
}
export async function crossQuery(value: string): Promise<string[]> { return [value]; }
`,
  "src/http.ts": `
import { crossQuery, normalizeSearchQuery } from "./search.js";

function sendJson(_res: unknown, _status: number, _payload: unknown): void {}

export async function handleApi(path: string, method: string, res: unknown): Promise<boolean> {
  if (path === "/api/search" && method === "GET") {
    let term: string;
    try {
      term = normalizeSearchQuery("database");
    } catch (error) {
      sendJson(res, 400, { error: String(error) });
      return true;
    }
    if (!term.includes("data")) {
      sendJson(res, 400, { error: "kind" });
      return true;
    }
    await Promise.resolve();
    sendJson(res, 200, await crossQuery(term));
    return true;
  }
  return false;
}
`,
  "fixtures/example-route.ts": `
export function fixtureRoute(path: string, res: unknown): boolean {
  if (path === "/fixture") { sendJson(res, 200, {}); return true; }
  return false;
}
function sendJson(_res: unknown, _status: number, _payload: unknown): void {}
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

withNative("deterministic execution flow", () => {
  it("persists and enumerates an HTTP route from entry to every response effect", async () => {
    root = await makeProject(PROJECT);
    const result = await scan(root, { full: true, kind: "execution-flow" });
    const db = await getDb(root);

    expect(result.executionEntries).toBe(1);
    const index = db.executionFlow();
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      label: "GET /api/search",
      symbol: "handleApi",
      freshness: "current",
      terminalEffects: 3,
      gaps: 1,
      producer: {
        id: "sdlc-http-route-adapter",
        version: "7",
        kind: "framework",
      },
      certainty: "inferred",
    });

    const view = db.executionFlow(index.entries[0].id);
    expect(view.selected).not.toBeNull();
    expect(view.selected?.paths).toHaveLength(3);
    expect(view.selected?.paths.map((path) => path.terminalEffect).sort()).toEqual([
      "http:response:200",
      "http:response:400",
      "http:response:400",
    ]);
    expect(
      view.selected?.paths
        .filter((path) => !path.complete)
        .map((path) => path.terminalEffect),
    ).toEqual(["http:response:200"]);
    expect(view.selected?.paths.some((path) => path.conditions.includes("try block throws"))).toBe(
      true,
    );
    expect(view.selected?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "call",
          target: expect.objectContaining({
            path: "src/search.ts",
            symbol: "normalizeSearchQuery",
            startLine: 2,
            endLine: 5,
          }),
        }),
        expect.objectContaining({
          kind: "await",
          target: expect.objectContaining({
            path: "src/search.ts",
            symbol: "crossQuery",
            startLine: 6,
            endLine: 6,
          }),
          resolution: "resolved",
        }),
        expect.objectContaining({
          kind: "await",
          label: "Await Promise.resolve",
          resolution: "unresolved",
        }),
      ]),
    );
    expect(view.selected?.diagnostics).toEqual([
      expect.stringContaining("cannot resolve the target of Await Promise.resolve"),
    ]);
  });

  it("replaces file-owned execution facts without leaving retired routes", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { full: true, kind: "execution-flow" });
    const db = await getDb(root);
    expect(db.executionFlow().entries.map((entry) => entry.route)).toEqual(["/api/search"]);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      `${root}/src/http.ts`,
      `export function handleApi(path: string, res: unknown): boolean {
         if (path === "/api/health") { sendJson(res, 200, { ok: true }); return true; }
         return false;
       }
       function sendJson(_res: unknown, _status: number, _payload: unknown): void {}`,
    );
    await scan(root, { kind: "execution-flow-change" });

    const entries = db.executionFlow().entries;
    expect(entries.map((entry) => entry.route)).toEqual(["/api/health"]);
    expect(db.count("SELECT COUNT(*) FROM execution_nodes")).toBeGreaterThan(0);
    expect(
      db.count(
        `SELECT COUNT(*) FROM execution_nodes n
         WHERE NOT EXISTS (SELECT 1 FROM execution_entries e WHERE e.id = n.entry_id)`,
      ),
    ).toBe(0);
  });

  it("keeps entries with long route literals queryable by their generated identity", async () => {
    const route = `/${"a".repeat(1_000)}`;
    root = await makeProject({
      "src/http.ts": `
function sendJson(_res: unknown, _status: number, _body: unknown): void {}
export function route(path: string, res: unknown): void {
  if (path === ${JSON.stringify(route)}) sendJson(res, 200, {});
}
`,
    });
    await scan(root, { full: true, kind: "execution-long-route" });
    const db = await getDb(root);
    const entry = db.executionFlow().entries[0];

    expect(entry?.route).toBe(route);
    expect(entry?.id.length).toBeLessThanOrEqual(512);
    expect(db.executionFlow(entry?.id).selected?.paths).toHaveLength(1);
  });

  it("resolves aliased imports by exact call occurrence", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ type: "module" }),
      "src/service.ts": `
export default async function defaultFn(): Promise<number> { return 1; }
export async function original(): Promise<number> { return 2; }
`,
      "src/http.ts": `
import localDefault from "./service.js";
import { original as localAlias } from "./service.js";
namespace NS { export type Fn = () => Promise<number>; }
function sendJson(_res: unknown, _status: number, _body: unknown): void {}
export async function route(path: string, res: unknown): Promise<void> {
  if (path === "/default") { await localDefault(); sendJson(res, 200, {}); }
  if (path === "/alias") { await localAlias(); sendJson(res, 200, {}); }
  if (path === "/wrapped") {
    localAlias!();
    (/* before */ localAlias as NS.Fn /* after */)();
    (localAlias satisfies () => Promise<number>)();
    sendJson(res, 200, {});
  }
}
`,
    });
    await scan(root, { full: true, kind: "execution-aliases" });
    const db = await getDb(root);
    const targets = new Map(
      db.executionFlow().entries.map((entry) => {
        const call = db
          .executionFlow(entry.id)
          .selected?.nodes.find((node) => node.kind === "await")?.target;
        return [entry.route, call];
      }),
    );

    expect(targets.get("/default")).toEqual({
      path: "src/service.ts",
      symbol: "defaultFn",
      startLine: 2,
      endLine: 2,
      external: "",
    });
    expect(targets.get("/alias")).toEqual({
      path: "src/service.ts",
      symbol: "original",
      startLine: 3,
      endLine: 3,
      external: "",
    });
    const wrapped = db
      .executionFlow(db.executionFlow().entries.find((entry) => entry.route === "/wrapped")?.id)
      .selected?.nodes.filter((node) => node.kind === "call");
    expect(wrapped).toHaveLength(3);
    expect(wrapped?.map((node) => node.target)).toEqual([
      { path: "src/service.ts", symbol: "original", startLine: 3, endLine: 3, external: "" },
      { path: "src/service.ts", symbol: "original", startLine: 3, endLine: 3, external: "" },
      { path: "src/service.ts", symbol: "original", startLine: 3, endLine: 3, external: "" },
    ]);
  });

  it("does not resolve a returned-function invocation back to its factory", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ type: "module" }),
      "src/factory.ts": `
export function factory(): () => number { return () => 1; }
`,
      "src/http.ts": `
import { factory } from "./factory.js";
function sendJson(_res: unknown, _status: number, _body: unknown): void {}
export function route(path: string, res: unknown): void {
  if (path === "/factory") { factory()(); sendJson(res, 200, {}); }
}
`,
    });
    await scan(root, { full: true, kind: "execution-returned-function" });
    const db = await getDb(root);
    const calls = db
      .executionFlow(db.executionFlow().entries[0]?.id)
      .selected?.nodes.filter((node) => node.kind === "call");

    expect(calls).toHaveLength(2);
    expect(calls?.[0]?.target).toEqual({
      path: "src/factory.ts",
      symbol: "factory",
      startLine: 2,
      endLine: 2,
      external: "",
    });
    expect(calls?.[1]?.target).toEqual({
      path: null,
      symbol: "factory()",
      startLine: null,
      endLine: null,
      external: "",
    });
  });

  it("refreshes member-call targets when compiler references replace syntax refs", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/*.ts"],
      }),
      "src/service.ts": `
export class Service { async query(): Promise<number> { return 1; } }
export const service = new Service();
`,
      "src/http.ts": `
import { service } from "./service.js";
function sendJson(_res: unknown, _status: number, _body: unknown): void {}
export async function route(path: string, res: unknown): Promise<void> {
  if (path === "/typed") { await service.query(); sendJson(res, 200, {}); }
}
`,
    });
    await scan(root, { full: true, kind: "execution-typed" });
    const db = await getDb(root);
    const entry = db.executionFlow().entries[0];
    const target = () =>
      db.executionFlow(entry.id).selected?.nodes.find((node) => node.kind === "await")?.target;
    expect(target()?.path).toBeNull();

    expect(resolveTypes(db, root).ran).toBe(true);
    expect(target()).toEqual({
      path: "src/service.ts",
      symbol: "query",
      startLine: 2,
      endLine: 2,
      external: "",
    });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      `${root}/src/service.ts`,
      `export class Service { async renamed(): Promise<number> { return 1; } }
       export const service = new Service();`,
    );
    await scan(root, { kind: "execution-typed-target-change" });
    expect(target()).toEqual({
      path: null,
      symbol: "query",
      startLine: null,
      endLine: null,
      external: "",
    });
  });

  it("distinguishes returns, uncaught throws, and unsupported control-flow gaps", async () => {
    root = await makeProject({
      "src/http.ts": `
function sendJson(_res: unknown, _status: number, _body: unknown): void {}
export function route(path: string, res: unknown, mode: string): boolean {
  if (path === "/return") {
    return true;
  }
  if (path === "/throw") {
    throw new Error("bad");
  }
  if (path === "/loop") {
    while (ready()) { work(); }
    sendJson(res, 200, {});
    return true;
  }
  if (path === "/switch") {
    switch (mode) {
      case "write": work(); break;
      default: break;
    }
    sendJson(res, 204, {});
    return true;
  }
  return false;
}
`,
    });
    await scan(root, { full: true, kind: "execution-outcomes" });
    const db = await getDb(root);
    const views = new Map(
      db.executionFlow().entries.map((entry) => [entry.route, db.executionFlow(entry.id)]),
    );

    const returnView = views.get("/return");
    expect(returnView?.selected?.paths).toEqual([
      expect.objectContaining({
        complete: true,
        terminalEffect: null,
        terminalOutcome: expect.objectContaining({ kind: "return", external: "return" }),
      }),
    ]);
    expect(returnView?.selected?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "return", resolution: "not-applicable" }),
      ]),
    );

    const throwView = views.get("/throw");
    expect(throwView?.selected?.paths).toEqual([
      expect.objectContaining({
        complete: true,
        terminalEffect: null,
        terminalOutcome: expect.objectContaining({ kind: "throw", external: "exception" }),
      }),
    ]);
    expect(throwView?.selected?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "throw", resolution: "not-applicable" }),
      ]),
    );

    const loopView = views.get("/loop");
    expect(loopView?.selected?.paths).toEqual([
      expect.objectContaining({
        terminalEffect: "http:response:200",
        terminalOutcome: {
          kind: "terminal-effect",
          label: "Respond HTTP 200",
          external: "http:response:200",
        },
        complete: false,
      }),
    ]);
    expect(loopView?.selected?.diagnostics).toEqual([
      expect.stringContaining("contains loop; paths through it are incomplete"),
    ]);

    const switchView = views.get("/switch");
    expect(switchView?.selected?.paths).toEqual([
      expect.objectContaining({
        terminalEffect: "http:response:204",
        terminalOutcome: {
          kind: "terminal-effect",
          label: "Respond HTTP 204",
          external: "http:response:204",
        },
        complete: false,
      }),
    ]);
    expect(switchView?.selected?.diagnostics).toEqual([
      expect.stringContaining("contains switch; paths through it are incomplete"),
    ]);
    expect(switchView?.selected?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "terminal-effect",
          resolution: "external",
        }),
      ]),
    );
  });

  it("returns current authored relations only in the opt-in asserted overlay", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { full: true, kind: "execution-assertions" });
    const db = await getDb(root);
    const entry = db.executionFlow().entries[0];
    const relation = relate(db, {
      kind: "calls",
      srcPath: "src/search.ts",
      srcSymbol: "crossQuery",
      dstPath: "src/result-store.ts",
      dstSymbol: "persistResults",
      label: "registered result-store writer",
      evidence: "export async function crossQuery(value: string): Promise<string[]> { return [value]; }",
      evidenceLine: 6,
      confidence: "high",
    });

    const deterministic = db.executionFlow(entry.id);
    const withAssertions = db.executionFlow(entry.id, 24, true);
    expect(deterministic.schemaVersion).toBe(4);
    expect(deterministic.selected?.assertedOverlay).toMatchObject({
      enabled: false,
      relations: [],
      truncated: false,
    });
    expect(withAssertions.selected?.nodes).toEqual(deterministic.selected?.nodes);
    expect(withAssertions.selected?.edges).toEqual(deterministic.selected?.edges);
    expect(withAssertions.selected?.paths).toEqual(deterministic.selected?.paths);
    expect(withAssertions.selected?.assertedOverlay.relations).toEqual([
      expect.objectContaining({
        kind: "calls",
        label: "registered result-store writer",
        from: { path: "src/search.ts", symbol: "crossQuery" },
        to: { path: "src/result-store.ts", symbol: "persistResults" },
        evidence: expect.objectContaining({ path: "src/search.ts", startLine: 6 }),
        provenance: {
          source: "agent",
          certainty: "asserted",
          confidence: "high",
          freshness: "current",
        },
        anchors: [
          expect.objectContaining({
            relationEndpoint: "source",
          }),
        ],
      }),
    ]);

    // Older stores accepted arbitrary numeric evidence lines. One malformed
    // authored row must not suppress the deterministic flow response.
    db.run("UPDATE relations SET evidence_line = -1 WHERE id = ?", [relation.id]);
    expect(
      db.executionFlow(entry.id, 24, true).selected?.assertedOverlay.relations[0]?.evidence
        .startLine,
    ).toBeNull();

    const { writeFile } = await import("node:fs/promises");

    // An assertion describes what the code means, so a comment does not
    // invalidate it — and the overlay must agree with every other reader.
    await writeFile(`${root}/src/search.ts`, `${PROJECT["src/search.ts"]}\n// changed`);
    await scan(root, { kind: "execution-assertion-comment" });
    expect(
      db.executionFlow(entry.id, 24, true).selected?.assertedOverlay.relations,
    ).toHaveLength(1);

    // A structural change does, because the claim was made about code that no
    // longer reads the same way.
    await writeFile(
      `${root}/src/search.ts`,
      `${PROJECT["src/search.ts"]}\nexport const added = true;\n`,
    );
    await scan(root, { kind: "execution-assertion-stale" });
    expect(db.executionFlow(entry.id, 24, true).selected?.assertedOverlay.relations).toEqual([]);
  });

  it("bounds asserted overlay candidates and reports truncation", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { full: true, kind: "execution-assertion-limit" });
    const db = await getDb(root);
    const entry = db.executionFlow().entries[0];
    for (let index = 0; index < 129; index++) {
      relate(db, {
        kind: "calls",
        srcPath: "src/search.ts",
        srcSymbol: "crossQuery",
        dstPath: `src/result-store-${index}.ts`,
        dstSymbol: "persistResults",
        evidence: `result store ${index}`,
      });
    }

    const overlay = db.executionFlow(entry.id, 24, true).selected?.assertedOverlay;
    expect(overlay?.relations).toHaveLength(128);
    expect(overlay?.truncated).toBe(true);
  });

  it("serves the deterministic paths through the existing MCP flow tool", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { full: true, kind: "execution-flow" });
    const server = createMcpServer({ defaultRoot: null });
    const client = new Client({ name: "flow-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "flow",
        arguments: { projectRoot: root, mode: "execution", includeAssertions: true },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      const response = JSON.parse(content?.type === "text" ? content.text : "{}") as {
        model?: string;
        selected?: {
          paths?: Array<{ terminalEffect?: string }>;
          assertedOverlay?: { enabled?: boolean };
        };
      };
      expect(response.model).toBe("entry-to-effect");
      expect(response.selected?.paths).toHaveLength(3);
      expect(response.selected?.assertedOverlay?.enabled).toBe(true);
      expect(response.selected?.paths?.map((path) => path.terminalEffect)).toContain(
        "http:response:200",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

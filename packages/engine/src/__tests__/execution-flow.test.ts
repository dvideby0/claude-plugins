import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDb } from "../db/db.js";
import { createMcpServer } from "../mcp/server.js";
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
      gaps: 0,
      producer: {
        id: "sdlc-http-route-adapter",
        version: "1",
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
    expect(view.selected?.paths.every((path) => path.complete)).toBe(true);
    expect(view.selected?.paths.some((path) => path.conditions.includes("try block throws"))).toBe(
      true,
    );
    expect(view.selected?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "call",
          target: expect.objectContaining({ path: "src/search.ts", symbol: "normalizeSearchQuery" }),
        }),
        expect.objectContaining({
          kind: "await",
          target: expect.objectContaining({ path: "src/search.ts", symbol: "crossQuery" }),
        }),
      ]),
    );
    expect(view.selected?.diagnostics).toEqual([]);
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
        arguments: { projectRoot: root, mode: "execution" },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      const response = JSON.parse(content?.type === "text" ? content.text : "{}") as {
        model?: string;
        selected?: { paths?: Array<{ terminalEffect?: string }> };
      };
      expect(response.model).toBe("entry-to-effect");
      expect(response.selected?.paths).toHaveLength(3);
      expect(response.selected?.paths?.map((path) => path.terminalEffect)).toContain(
        "http:response:200",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

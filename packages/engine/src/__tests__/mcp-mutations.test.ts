import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../mcp/server.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("MCP workspace publication", () => {
  it("publishes successful index and knowledge writes but not reads", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "mcp-fixture" }),
      "src/app.ts": "export function run() { return true; }\n",
    });
    const changes: Array<{ root: string; kind: "indexed" | "updated" }> = [];
    const server = createMcpServer({
      defaultRoot: null,
      onWorkspaceChanged: async (changedRoot, kind) => {
        changes.push({ root: changedRoot, kind });
      },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const scan = await client.callTool({
        name: "audit_scan",
        arguments: { projectRoot: root },
      });
      expect(scan.isError).not.toBe(true);
      expect(changes).toEqual([{ root, kind: "indexed" }]);

      const status = await client.callTool({
        name: "audit_status",
        arguments: { projectRoot: root },
      });
      expect(status.isError).not.toBe(true);
      expect(changes).toHaveLength(1);

      const memory = await client.callTool({
        name: "remember",
        arguments: {
          projectRoot: root,
          kind: "gotcha",
          title: "Keep this visible",
          body: "A bridge write must invalidate an open desktop view.",
        },
      });
      expect(memory.isError).not.toBe(true);
      expect(changes.at(-1)).toEqual({ root, kind: "updated" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

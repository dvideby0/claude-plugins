import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { sourceContentSha } from "../lib/workspace-path.js";
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

      const db = await getDb(root);
      const indexedSha = db.get<{ content_sha: string }>(
        "SELECT content_sha FROM files WHERE path = ?",
        ["src/app.ts"],
      )!.content_sha;
      const changedSource = "export function run() { return false; }\n";
      await writeFile(join(root, "src/app.ts"), changedSource);
      const finding = await client.callTool({
        name: "audit_record_findings",
        arguments: {
          projectRoot: root,
          findings: [
            {
              ruleId: "llm/current-source",
              category: "correctness",
              severity: "medium",
              confidence: "high",
              title: "Finding from the changed working file",
              path: "src/app.ts",
              lineStart: 1,
            },
          ],
        },
      });
      expect(finding.isError).not.toBe(true);
      const evidenceSha = db.get<{ content_sha: string }>(
        "SELECT content_sha FROM findings WHERE rule_id = ?",
        ["llm/current-source"],
      )!.content_sha;
      expect(evidenceSha).toBe(sourceContentSha(changedSource));
      expect(evidenceSha).not.toBe(indexedSha);

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

  it("labels a past-EOF fallback slice with its actual current line numbers", async () => {
    root = await makeProject({
      "src/short.ts": "one\ntwo\nthree",
    });
    const server = createMcpServer({ defaultRoot: null });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "read_file",
        arguments: {
          projectRoot: root,
          path: "src/short.ts",
          startLine: 40,
          endLine: 42,
        },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content[0];
      const response = JSON.parse(content?.type === "text" ? content.text : "{}") as {
        startLine?: number;
        endLine?: number;
        totalLines?: number;
        content?: string;
      };
      expect(response).toMatchObject({
        startLine: 1,
        endLine: 3,
        totalLines: 3,
        content: "    1  one\n    2  two\n    3  three",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

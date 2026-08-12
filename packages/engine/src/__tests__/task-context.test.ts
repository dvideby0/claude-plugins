import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { remember } from "../memory/store.js";
import { createMcpServer } from "../mcp/server.js";
import { buildTaskContext } from "../plan/task-context.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("budgeted task context", () => {
  it("ranks task, graph, authored, test, and source evidence with navigable references", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "task-context" }),
      "src/checkout.ts": [
        "export function checkoutOrder(target: string) {",
        "  return target.startsWith('/') ? target : '/';",
        "}",
        "export function writeLedger() { return 'recorded'; }",
        "",
      ].join("\n"),
      "src/checkout.test.ts": [
        "import { checkoutOrder } from './checkout.js';",
        "checkoutOrder('/receipt');",
        "",
      ].join("\n"),
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const sourceSha = db.get<{ content_sha: string }>(
      "SELECT content_sha FROM files WHERE path = ?",
      ["src/checkout.ts"],
    )!.content_sha;
    const now = new Date().toISOString();
    const memory = remember(db, {
      kind: "gotcha",
      title: "Checkout redirects stay local",
      body: "Never return an unvalidated external redirect target.",
      anchors: [{ path: "src/checkout.ts", symbol: "checkoutOrder" }],
    });
    db.run(
      `INSERT INTO findings(
         id, rule_id, category, severity, confidence, source, path, line_start, line_end,
         content_sha, title, description, status
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [
        "unsafe-redirect",
        "fixture/redirect",
        "security",
        "high",
        "high",
        "fixture",
        "src/checkout.ts",
        2,
        2,
        sourceSha,
        "Validate checkout redirects",
        "The fallback must reject external targets.",
      ],
    );
    db.run(
      "INSERT INTO flows(id, name, summary, trigger, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
      ["checkout", "Checkout flow", "Validates and returns a receipt path.", "request", now, now],
    );
    db.run(
      `INSERT INTO flow_steps(flow_id, ordinal, label, path, symbol, note, content_sha)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        "checkout",
        0,
        "validate redirect",
        "src/checkout.ts",
        "checkoutOrder",
        "Local-only boundary.",
        sourceSha,
      ],
    );
    db.run(
      `INSERT INTO relations(
         id, kind, src_path, src_symbol, dst_path, dst_symbol, label, evidence,
         evidence_line, confidence, source, content_sha, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "checkout-ledger",
        "dispatch",
        "src/checkout.ts",
        "checkoutOrder",
        "src/checkout.ts",
        "writeLedger",
        "records checkout",
        "The checkout adapter calls the ledger registration hook.",
        2,
        "high",
        "human",
        sourceSha,
        now,
        now,
      ],
    );

    const brief = await buildTaskContext(db, root, {
      task: "debug the checkout redirect and ledger behavior",
      targets: ["src/checkout.ts"],
      intent: "debug",
      budgetBytes: 30_000,
    });
    const ids = brief.evidence.map((item) => item.id);
    expect(brief.targets[0]).toMatchObject({ status: "resolved", path: "src/checkout.ts" });
    expect(ids).toEqual(
      expect.arrayContaining([
        `memory:${memory.id}`,
        "finding:unsafe-redirect",
        "flow:checkout",
        "relation:checkout-ledger",
      ]),
    );
    expect(brief.readFirst).toEqual(
      expect.arrayContaining(["src/checkout.ts", "src/checkout.test.ts"]),
    );
    expect(brief.text).toContain("Source excerpt:");
    expect(brief.text).toContain("Fact: finding:unsafe-redirect.");
    expect(
      brief.evidence.every(
        (item) =>
          !item.source ||
          (item.source.path.length > 0 && item.source.startLine > 0 && item.source.endLine > 0),
      ),
    ).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(brief, null, 2), "utf8");
    expect(bytes).toBeLessThanOrEqual(30_000);
    expect(brief.budget.usedBytes).toBe(bytes);
  });

  it("compacts excerpts before dropping ranked facts and never exceeds the response budget", async () => {
    const longLine = `export const payload = "${"x".repeat(8_000)}";\n`;
    root = await makeProject({ "src/large.ts": longLine });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const brief = await buildTaskContext(db, root, {
      task: "change the payload",
      targets: ["src/large.ts"],
      intent: "implement",
      budgetBytes: 6_000,
    });
    const bytes = Buffer.byteLength(JSON.stringify(brief, null, 2), "utf8");
    expect(bytes).toBeLessThanOrEqual(6_000);
    expect(brief.budget.usedBytes).toBe(bytes);
    expect(brief.budget.truncated).toBe(true);
    expect(brief.evidence[0]?.source?.path).toBe("src/large.ts");
  });

  it("marks selected evidence stale when the working source changes after indexing", async () => {
    root = await makeProject({
      "src/policy.ts": "export function policy() { return 'old'; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    remember(db, {
      kind: "decision",
      title: "Policy compatibility",
      body: "Keep the persisted value readable.",
      anchors: [{ path: "src/policy.ts", symbol: "policy" }],
    });
    await writeFile(join(root, "src/policy.ts"), "export function policy() { return 'new'; }\n");

    const brief = await buildTaskContext(db, root, {
      task: "review policy compatibility",
      targets: ["src/policy.ts"],
      intent: "review",
      budgetBytes: 20_000,
    });
    expect(brief.evidence.some((item) => item.source?.freshness === "stale")).toBe(true);
    expect(brief.followUps).toContain("Re-index before trusting stale source-backed evidence.");
  });

  it("does not guess when a symbol target is ambiguous", async () => {
    root = await makeProject({
      "src/a.ts": "export function run() { return 'a'; }\n",
      "src/b.ts": "export function run() { return 'b'; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const brief = await buildTaskContext(db, root, {
      targets: ["run"],
      budgetBytes: 12_000,
    });
    expect(brief.targets[0]).toMatchObject({ status: "ambiguous", kind: "symbol" });
    expect(brief.uncertainties).toContain(
      "At least one explicit target is ambiguous and was not guessed; refine it to add graph neighbours.",
    );
    expect(brief.followUps[0]).toContain("Refine ambiguous targets");
  });

  it("evolves the existing brief tool without growing the MCP catalog", async () => {
    root = await makeProject({
      "src/app.ts": "export function startApplication() { return 'ready'; }\n",
    });
    const server = createMcpServer({ defaultRoot: null });
    const client = new Client({ name: "task-context-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(33);
      await client.callTool({
        name: "audit_scan",
        arguments: { projectRoot: root },
      });
      const taskFirst = await client.callTool({
        name: "brief",
        arguments: {
          projectRoot: root,
          task: "understand startApplication startup",
          intent: "understand",
          budget: 8_000,
        },
      });
      expect(taskFirst.isError).not.toBe(true);
      const taskContent = taskFirst.content[0];
      const taskResponse = JSON.parse(
        taskContent?.type === "text" ? taskContent.text : "{}",
      ) as { schemaVersion?: number; evidence?: unknown[] };
      expect(taskResponse.schemaVersion).toBe(2);
      expect(taskResponse.evidence?.length).toBeGreaterThan(0);

      const legacyTarget = await client.callTool({
        name: "brief",
        arguments: { projectRoot: root, target: "src/app.ts", budget: 8_000 },
      });
      expect(legacyTarget.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

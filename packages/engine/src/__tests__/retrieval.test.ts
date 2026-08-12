import { afterEach, describe, expect, it } from "vitest";
import { getDb, type KnowledgeKind } from "../db/db.js";
import { crossQuery } from "../graph/cross.js";
import { forget, remember } from "../memory/store.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("knowledge retrieval", () => {
  it("searches one incrementally maintained FTS5 index across fact classes", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "checkout-fixture" }),
      "src/checkout/service.ts":
        "export function checkoutOrder() { return 'receipt'; }\n" +
        "export function ledgerWriter() { return 'ledger'; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const now = new Date().toISOString();
    const sourceSha = db.get<{ content_sha: string }>(
      "SELECT content_sha FROM files WHERE path = ?",
      ["src/checkout/service.ts"],
    )!.content_sha;

    const memory = remember(db, {
      kind: "decision",
      title: "Batch checkout writes",
      body: "The payment provider charges per transaction.",
      anchors: [{ path: "src/checkout/service.ts", symbol: "checkoutOrder" }],
    });
    db.run(
      `INSERT INTO findings(
         id, rule_id, category, severity, confidence, source, path, line_start, line_end,
         content_sha, title, description, status
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [
        "finding-1",
        "unsafe-redirect",
        "security",
        "high",
        "high",
        "fixture",
        "src/checkout/service.ts",
        2,
        2,
        sourceSha,
        "Unsafe checkout redirect",
        "Validate the redirect target.",
      ],
    );
    db.run(
      "INSERT INTO components(id, name, summary, kind, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
      ["payments", "Payments boundary", "Owns checkout operations.", "service", now, now],
    );
    db.run(
      "INSERT INTO component_members(component_id, pattern, symbol) VALUES(?, ?, ?)",
      ["payments", "src/checkout/**", "checkoutOrder"],
    );
    db.run(
      "INSERT INTO flows(id, name, summary, trigger, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
      ["purchase", "Purchase flow", "Completes checkout.", "HTTP POST", now, now],
    );
    db.run(
      `INSERT INTO flow_steps(flow_id, ordinal, label, path, symbol, note)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [
        "purchase",
        0,
        "emitReceiptLedger",
        "src/checkout/service.ts",
        "checkoutOrder",
        "Records completion.",
      ],
    );
    db.run(
      `INSERT INTO relations(
         id, kind, src_path, src_symbol, dst_path, dst_symbol, label, evidence,
         confidence, source, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "relation-1",
        "dispatch",
        "src/checkout/service.ts",
        "checkoutOrder",
        "src/receipt.ts",
        "publishReceipt",
        "ledger",
        "Dispatch invoice registered by the checkout adapter.",
        "high",
        "human",
        now,
        now,
      ],
    );

    expect(db.searchKnowledge("checkoutOrder", ["symbol"])[0]).toMatchObject({
      kind: "symbol",
      title: "checkoutOrder",
      path: "src/checkout/service.ts",
      lineStart: 1,
      lineEnd: 1,
    });
    expect(db.searchKnowledge("checkout service", ["file"])[0]?.kind).toBe("file");
    expect(db.searchKnowledge("payment provider", ["memory"])[0]?.sourceId).toBe(memory.id);
    expect(db.searchKnowledge("unsafe redirect", ["finding"])[0]).toMatchObject({
      sourceId: "finding-1",
      lineStart: 2,
      lineEnd: 2,
      evidenceSha: sourceSha,
    });
    expect(db.searchKnowledge("payments boundary", ["component"])[0]?.sourceId).toBe(
      "payments",
    );
    expect(db.searchKnowledge("emitReceiptLedger", ["flow"])[0]?.sourceId).toBe("purchase");
    expect(db.searchKnowledge("dispatch invoice", ["relation"])[0]?.sourceId).toBe(
      "relation-1",
    );

    // Exact-match priority is part of the local order even when another
    // document has a stronger raw BM25 score. Cross-workspace merging must
    // preserve that order rather than compare corpus-dependent scores.
    const localLedger = db.searchKnowledge("ledger");
    expect(localLedger[0]?.sourceId).toBe("relation-1");
    expect(localLedger.find((hit) => hit.sourceId.includes("ledgerWriter"))?.score)
      .toBeGreaterThan(localLedger[0]?.score ?? 0);
    const crossLedger = await crossQuery(
      [{ id: "fixture", name: "fixture", root }],
      "all",
      "ledger",
    );
    expect(crossLedger.hits[0]?.detail.sourceId).toBe("relation-1");

    const all = await crossQuery(
      [{ id: "fixture", name: "fixture", root }],
      "all",
      "checkout",
    );
    expect([...new Set(all.hits.map((hit) => hit.detail.kind))]).toEqual(
      expect.arrayContaining(["file", "symbol", "memory", "finding", "component"]),
    );
    expect(all.hits.find((hit) => hit.detail.kind === "symbol")?.detail).toMatchObject({
      lineStart: 1,
      lineEnd: 1,
    });
    expect(all.hits.find((hit) => hit.detail.kind === "finding")?.detail).toMatchObject({
      lineStart: 2,
      lineEnd: 2,
      evidenceSha: sourceSha,
    });
    expect(all.unreadable).toEqual([]);

    const freshMemory = await crossQuery(
      [{ id: "fixture", name: "fixture", root }],
      "memory",
      "payment provider",
    );
    expect(freshMemory.hits[0]?.detail).toMatchObject({
      kind: "memory",
      memoryKind: "decision",
      stale: false,
      anchors: [
        { path: "src/checkout/service.ts", symbol: "checkoutOrder", stale: false },
      ],
    });
    db.run("UPDATE files SET content_sha = ? WHERE path = ?", [
      "changed-after-memory-was-recorded",
      "src/checkout/service.ts",
    ]);
    const staleMemory = await crossQuery(
      [{ id: "fixture", name: "fixture", root }],
      "memory",
      "payment provider",
    );
    expect(staleMemory.hits[0]?.detail).toMatchObject({
      stale: true,
      anchors: [{ stale: true }],
    });

    // Source-table lifecycle changes update the external-content index in the
    // same transaction, including child rows aggregated into map documents.
    db.run("UPDATE findings SET status = 'fixed' WHERE id = 'finding-1'");
    expect(db.searchKnowledge("unsafe redirect", ["finding"])).toEqual([]);
    expect(forget(db, memory.id)).toBe(true);
    expect(db.searchKnowledge("payment provider", ["memory"])).toEqual([]);
    db.run(
      "UPDATE component_members SET pattern = ? WHERE component_id = ? AND pattern = ? AND symbol = ?",
      ["src/billing/**", "payments", "src/checkout/**", "checkoutOrder"],
    );
    expect(db.searchKnowledge("billing", ["component"])[0]?.sourceId).toBe("payments");
    db.run("DELETE FROM flow_steps WHERE flow_id = 'purchase'");
    expect(db.searchKnowledge("emitReceiptLedger", ["flow"])).toEqual([]);

    // With rank=1, FTS5 compares the external index against its relational
    // content table rather than only checking the virtual table's structure.
    db.run("INSERT INTO knowledge_fts(knowledge_fts, rank) VALUES('integrity-check', 1)");
  });

  it("bounds and normalizes caller input instead of accepting raw FTS syntax", async () => {
    root = await makeProject({
      "package.json": "{}",
      "src/query.ts": "export function queryRecords() { return []; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(() => db.searchKnowledge('queryRecords OR "unterminated')).not.toThrow();
    expect(db.searchKnowledge("queryRecords definitely-absent", ["symbol"])[0]).toMatchObject({
      title: "queryRecords",
    });
    expect(() => db.searchKnowledge("x".repeat(513))).toThrow(/at most 512 characters/);
    expect(() =>
      db.searchKnowledge("query", ["not-a-kind" as KnowledgeKind]),
    ).toThrow(/Unknown knowledge search kind/);
    await expect(
      crossQuery([{ id: "fixture", name: "fixture", root }], "symbol", "x".repeat(513)),
    ).rejects.toThrow(/at most 512 characters/);
  });

  it("does not rewrite file search documents for scan bookkeeping updates", async () => {
    root = await makeProject({
      "package.json": "{}",
      "src/stable.ts": "export const stableSearchDocument = true;\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    db.run("CREATE TEMP TABLE search_document_deletes(id TEXT NOT NULL)");
    db.run(
      `CREATE TEMP TRIGGER track_file_search_deletes
       AFTER DELETE ON search_documents WHEN old.kind = 'file'
       BEGIN
         INSERT INTO search_document_deletes(id) VALUES(old.id);
       END`,
    );

    db.run(
      "UPDATE files SET last_seen_run = COALESCE(last_seen_run, 0) + 1 WHERE path = ?",
      ["src/stable.ts"],
    );
    expect(db.count("SELECT COUNT(*) AS n FROM search_document_deletes")).toBe(0);

    db.run("UPDATE files SET lang = 'tsx' WHERE path = ?", ["src/stable.ts"]);
    expect(db.count("SELECT COUNT(*) AS n FROM search_document_deletes")).toBe(1);
    expect(db.searchKnowledge("tsx", ["file"])[0]?.sourceId).toBe("src/stable.ts");
  });
});

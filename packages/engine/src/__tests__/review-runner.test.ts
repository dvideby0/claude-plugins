import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { planUnits, savePlan } from "../plan/risk.js";
import type { AgentResult } from "../review/agent.js";
import { runReview } from "../review/runner.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

const result = (overrides: Partial<AgentResult>): AgentResult => ({
  ok: true,
  text: "[]",
  costUsd: 0.1,
  durationMs: 10,
  error: null,
  ...overrides,
});

async function plannedReview() {
  root = await makeProject({ "src/index.ts": "export function value() { return 1; }\n" });
  await scan(root, { kind: "full" });
  const db = await getDb(root);
  savePlan(db, planUnits(db, { maxUnits: 1 }));
  return db;
}

describe("model review outcomes", () => {
  it("rejects a non-positive unit cap before starting paid work", async () => {
    const db = await plannedReview();
    let calls = 0;

    await expect(
      runReview(db, root, {
        maxUnits: 0,
        runAgent: async () => {
          calls++;
          return result({});
        },
      }),
    ).rejects.toThrow("positive integer");
    expect(calls).toBe(0);
  });

  it.each(["not JSON", JSON.stringify([{ title: "Incomplete finding" }])])(
    "records malformed first-pass output as a failed unit",
    async (text) => {
      const db = await plannedReview();
      const summary = await runReview(db, root, {
        runAgent: async () => result({ text }),
      });

      expect(summary.failures[0]?.error).toContain("malformed findings");
      expect(
        db.get<{ status: string; detail: string }>(
          "SELECT status, detail FROM review_runs ORDER BY id DESC LIMIT 1",
        ),
      ).toMatchObject({ status: "failed", detail: "Review returned malformed findings JSON." });
    },
  );

  it.each([
    [result({ ok: false, error: "quota exhausted" }), "Verification failed"],
    [result({ text: "not JSON" }), "malformed verdict"],
  ])(
    "records verifier infrastructure failure instead of rejecting claims",
    async (verification, error) => {
      const db = await plannedReview();
      const finding = JSON.stringify([
        {
          ruleId: "llm/value",
          category: "correctness",
          severity: "medium",
          confidence: "high",
          title: "Value is wrong",
          path: "src/index.ts",
          lineStart: 1,
        },
      ]);
      const responses = [result({ text: finding }), verification];
      const summary = await runReview(db, root, {
        runAgent: async () => responses.shift() as AgentResult,
      });

      expect(summary.proposed).toBe(1);
      expect(summary.rejected).toBe(0);
      expect(summary.failures[0]?.error).toContain(error);
      expect(
        db.get<{ status: string }>("SELECT status FROM review_runs ORDER BY id DESC LIMIT 1"),
      ).toEqual({ status: "failed" });
    },
  );
});

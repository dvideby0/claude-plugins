import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PROPOSALS_PER_UNIT,
  isSubstantiatedVerdict,
  selectReviewProposals,
  sourceFor,
  type ProposedFinding,
} from "../review/runner.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

function finding(index: number, overrides: Partial<ProposedFinding> = {}): ProposedFinding {
  return {
    ruleId: `llm/rule-${index}`,
    category: "correctness",
    severity: "medium",
    confidence: "high",
    title: `Finding ${index}`,
    path: "src/index.ts",
    lineStart: index + 1,
    ...overrides,
  };
}

describe("review proposal policy", () => {
  it("requires real positive source lines", () => {
    expect(
      selectReviewProposals([
        finding(0, { lineStart: Number.NaN }),
        finding(1, { lineStart: 0 }),
        finding(2, { lineStart: 3, lineEnd: 2 }),
        finding(3),
      ]),
    ).toEqual([finding(3)]);
  });

  it("deduplicates and caps model-controlled verification work", () => {
    const proposals = Array.from({ length: MAX_PROPOSALS_PER_UNIT + 10 }, (_, index) =>
      finding(index),
    );
    proposals.splice(1, 0, { ...proposals[0] });

    const selected = selectReviewProposals(proposals);
    expect(selected).toHaveLength(MAX_PROPOSALS_PER_UNIT);
    expect(new Set(selected.map((item) => item.ruleId)).size).toBe(MAX_PROPOSALS_PER_UNIT);
  });

  it("accepts only a literal boolean true verification verdict", () => {
    expect(isSubstantiatedVerdict({ substantiated: true })).toBe(true);
    expect(isSubstantiatedVerdict({ substantiated: false })).toBe(false);
    expect(isSubstantiatedVerdict({ substantiated: "true" })).toBe(false);
    expect(isSubstantiatedVerdict({ substantiated: "false" })).toBe(false);
  });

  it("fingerprints the complete source generation used for verification", async () => {
    root = await makeProject({ "src/index.ts": "export const value = 1;\n" });
    const verified = await sourceFor(root, "src/index.ts", 1);

    await writeFile(join(root, "src/index.ts"), "export const value = 2;\n");
    const current = await sourceFor(root, "src/index.ts", 1);

    expect(current.contentSha).not.toBe(verified.contentSha);
  });
});

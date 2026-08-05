import { describe, expect, it } from "vitest";
import {
  MAX_PROPOSALS_PER_UNIT,
  selectReviewProposals,
  type ProposedFinding,
} from "../review/runner.js";

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
});

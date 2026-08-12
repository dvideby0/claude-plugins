import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiderEvidence,
  loadRetrievalOracle,
  retrievalOracleSchema,
  runRetrievalEvaluation,
  scoreRetrievalContext,
  type EvidenceUnit,
  type RetrievalScenario,
} from "../eval/retrieval.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/retrieval/typescript-checkout/", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureOracle(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(fixture, "oracle.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("retrieval evaluation", () => {
  it("loads a strict versioned oracle and rejects ambiguous truth", async () => {
    const loaded = await loadRetrievalOracle(join(fixture, "oracle.json"));
    expect(loaded).toMatchObject({
      schemaVersion: 1,
      scenario: "typescript-checkout-task-context",
      baseline: { generator: { id: "aider-chat", version: "0.86.2" } },
    });

    const raw = await fixtureOracle();
    const scenarios = raw.scenarios as Array<Record<string, unknown>>;
    expect(() =>
      retrievalOracleSchema.parse({ ...raw, scenarios: [scenarios[0], scenarios[0]] }),
    ).toThrow("Retrieval scenario ids must be unique");
    expect(() =>
      retrievalOracleSchema.parse({
        ...raw,
        scenarios: [
          {
            ...scenarios[0],
            requiredEvidence: [{ symbol: "submitCheckout" }],
          },
        ],
      }),
    ).toThrow("also needs its repository-relative path");
    expect(() =>
      retrievalOracleSchema.parse({
        ...raw,
        scenarios: [
          {
            ...scenarios[0],
            thresholds: {
              ...(scenarios[0]?.thresholds as Record<string, unknown>),
              maximumSdlcPackedTokens: 1601,
            },
          },
        ],
      }),
    ).toThrow("cannot exceed the Aider map-token target");
  });

  it("preserves Aider's own file order and symbol text without reproducing its ranking", () => {
    const evidence = aiderEvidence(
      [
        "src/b.ts:",
        "│export function beta() {}",
        "⋮",
        "src/a.ts:",
        "│export function alpha() {}",
        "",
      ].join("\n"),
      ["src/a.ts", "src/b.ts"],
    );

    expect(evidence.map((item) => item.path)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(evidence[0]?.content).toContain("beta");
    expect(evidence[1]?.content).toContain("alpha");
  });

  it("scores path recall, required evidence, noise, tokens, and the byte ceiling", () => {
    const scenario: RetrievalScenario = {
      id: "scorer",
      task: "inspect alpha",
      targets: [],
      intent: "review",
      budgetBytes: 6000,
      rankK: 2,
      relevantPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      requiredEvidence: [
        { path: "src/a.ts", symbol: "alpha" },
        { kind: "memory", title: "Alpha rule" },
        { path: "src/c.ts" },
      ],
      thresholds: {
        minimumSdlcRecallAtK: 0,
        minimumSdlcEvidenceCoverage: 0,
        maximumSdlcIrrelevantContextRate: 1,
        maximumSdlcPackedTokens: 10_000,
        minimumRecallDeltaVsAider: -1,
        minimumEvidenceCoverageDeltaVsAider: -1,
        maximumIrrelevantContextRateDeltaVsAider: 1,
        maximumPackedTokenRatioVsAider: 10,
      },
    };
    const evidence: EvidenceUnit[] = [
      {
        path: "src/a.ts",
        symbol: "alpha",
        kind: "symbol",
        title: "alpha",
        content: "alpha",
      },
      {
        path: "src/noise.ts",
        symbol: null,
        kind: "file",
        title: "noise",
        content: "noise",
      },
      {
        path: null,
        symbol: null,
        kind: "memory",
        title: "Alpha rule",
        content: "Keep alpha stable.",
      },
      {
        path: "src/b.ts",
        symbol: "beta",
        kind: "symbol",
        title: "beta",
        content: "beta",
      },
    ];

    const context = "x".repeat(6001);
    const scored = scoreRetrievalContext(context, evidence, scenario);
    expect(scored).toMatchObject({
      recallAtK: 0.333333,
      evidenceCoverage: 0.666667,
      irrelevantContextRate: 0.333333,
      packedBytes: 6001,
      withinBudget: false,
      rankedPaths: ["src/a.ts", "src/noise.ts", "src/b.ts"],
    });
    expect(scored.packedTokens).toBeGreaterThan(0);
    expect(scored.missingEvidence).toEqual([{ path: "src/c.ts" }]);
  });

  it("refuses to compare a changed source tree with a stale checked-in map", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdlc-retrieval-stale-"));
    temporaryRoots.push(root);
    await cp(fixture, root, { recursive: true });
    await writeFile(
      join(root, "source/src/checkout.ts"),
      "export function changedCheckout() { return true; }\n",
    );

    await expect(runRetrievalEvaluation(root)).rejects.toThrow(
      "does not match the Aider baseline",
    );
  });

  it("runs the checked-in corpus while keeping the first slice experimental", async () => {
    const report = await runRetrievalEvaluation(fixture);

    expect(report.passed).toBe(true);
    expect(report.promotion).toMatchObject({
      eligible: false,
      status: "keep-experimental",
    });
    expect(report.baseline).toMatchObject({
      mapTokens: 1600,
      packedTokens: 982,
    });
    const review = report.scenarios.find(
      (scenario) => scenario.id === "review-inventory-reservation",
    )!;
    expect(review.sdlc.irrelevantContextRate).toBeLessThan(
      review.aider.irrelevantContextRate!,
    );
    const debug = report.scenarios.find((scenario) => scenario.id === "debug-idempotency")!;
    expect(debug.sdlc.recallAtK).toBeGreaterThan(debug.aider.recallAtK);
    expect(debug.sdlc.matchedEvidence).toContainEqual({
      kind: "memory",
      title: "Checkout idempotency requirement",
    });
    expect(debug.sdlc.missingEvidence).toEqual([
      { path: "src/ledger.ts", symbol: "recordCheckout" },
    ]);
  });
});

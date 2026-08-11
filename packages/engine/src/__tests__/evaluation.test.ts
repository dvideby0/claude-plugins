import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FactBatch, FactEdge, FactNode } from "../facts/model.js";
import {
  evaluationOracleSchema,
  loadEvaluationOracle,
  scoreFactBatch,
  thresholdFailures,
  type EvaluationOracle,
} from "../eval/model.js";
import {
  compilerPipelineFacts,
  missingScipTestFiles,
  runEvaluationWorker,
  scipConstraintFailures,
  scipDocumentFilter,
  scipTestAssertions,
} from "../eval/worker.js";
import { loadNative } from "../scan/source.js";

const oracle: EvaluationOracle = evaluationOracleSchema.parse({
  schemaVersion: 2,
  scenario: "scorer-test",
  languages: ["typescript"],
  features: ["symbol", "reference"],
  providers: ["native-tree-sitter"],
  change: { path: "src/a.ts", append: "\n// change\n" },
  symbols: [{ path: "src/a.ts", name: "entry", startLine: 1 }],
  references: [
    { sourcePath: "src/a.ts", targetPath: "src/b.ts", targetSymbol: "target" },
  ],
  thresholds: {
    "native-tree-sitter": {
      symbols: { minimumPrecision: 1, minimumRecall: 1 },
      references: { minimumPrecision: 1, minimumRecall: 1 },
    },
  },
});

const base = {
  schemaVersion: 1 as const,
  workspaceId: "workspace",
  producer: { id: "fixture", version: "1", kind: "parsed" as const },
  generation: { sourceSignature: "source" },
  certainty: "exact" as const,
  freshness: "current" as const,
  ownership: { scope: "file" as const, key: "src/a.ts" },
  evidence: [],
  createdAt: "1970-01-01T00:00:00.000Z",
};

function symbol(id: string, path: string, name: string, startLine: number): FactNode {
  return {
    ...base,
    type: "node",
    id,
    kind: "symbol",
    name,
    anchor: {
      path,
      symbol: name,
      range: { startLine, startColumn: 0, endLine: startLine, endColumn: name.length },
    },
  };
}

function reference(id: string, targetPath: string): FactEdge {
  return {
    ...base,
    type: "edge",
    id,
    kind: "reference",
    source: { path: "src/a.ts" },
    target: { path: targetPath, symbol: "target" },
  };
}

function batch(nodes: FactNode[], edges: FactEdge[]): FactBatch {
  return {
    schemaVersion: 1,
    workspaceId: "workspace",
    generation: { sourceSignature: "source" },
    generatedAt: "1970-01-01T00:00:00.000Z",
    nodes,
    edges,
  };
}

describe("evaluation scorer", () => {
  it("scores the selected neutral facts and deduplicates repeated provider occurrences", () => {
    const scores = scoreFactBatch(
      batch(
        [
          symbol("expected", "src/a.ts", "entry", 1),
          symbol("duplicate", "src/a.ts", "entry", 1),
          symbol("out-of-scope", "src/a.ts", "helper", 4),
        ],
        [
          reference("expected", "src/b.ts"),
          reference("duplicate", "src/b.ts"),
          reference("wrong-target", "src/c.ts"),
        ],
      ),
      oracle,
    );

    expect(scores.symbols).toMatchObject({
      expected: 1,
      actual: 1,
      precision: 1,
      recall: 1,
      falsePositives: 0,
    });
    expect(scores.references).toMatchObject({
      expected: 1,
      actual: 2,
      precision: 0.5,
      recall: 1,
      falsePositives: 1,
    });
    expect(scores.references.unexpected).toEqual([
      { sourcePath: "src/a.ts", targetPath: "src/c.ts", targetSymbol: "target" },
    ]);
  });

  it("reports no-candidate precision honestly and fails configured thresholds", () => {
    const scores = scoreFactBatch(batch([], []), oracle);

    expect(scores.symbols).toMatchObject({ precision: null, recall: 0, f1: null });
    expect(thresholdFailures("native-tree-sitter", scores, oracle)).toEqual([
      "symbols precision unavailable is below 1",
      "symbols recall 0 is below 1",
      "references precision unavailable is below 1",
      "references recall 0 is below 1",
    ]);
  });

  it("loads the checked-in oracle through the versioned strict schema", async () => {
    const path = fileURLToPath(
      new URL("../../fixtures/eval/typescript-entry-effect/oracle.json", import.meta.url),
    );
    await expect(loadEvaluationOracle(path)).resolves.toMatchObject({
      schemaVersion: 2,
      scenario: "typescript-entry-effect",
      symbols: expect.arrayContaining([
        expect.objectContaining({ path: "src/main.ts", name: "handleAccount" }),
      ]),
    });
    expect(() => evaluationOracleSchema.parse({ ...oracle, unknownField: true })).toThrow();
  });

  it("loads provider-scoped Python truth while keeping entry-to-effect scoring explicit", async () => {
    const path = fileURLToPath(
      new URL(
        "../../fixtures/eval/python-langgraph-entry-effect/oracle.json",
        import.meta.url,
      ),
    );

    const loaded = await loadEvaluationOracle(path);
    expect(loaded).toMatchObject({
      schemaVersion: 2,
      languages: ["python"],
      providers: ["typescript-fallback", "native-tree-sitter", "scip-python"],
      entryToEffect: {
        entrypoints: [expect.objectContaining({ id: "subject-lookup" })],
      },
    });
    expect(loaded.entryToEffect?.relations).toHaveLength(12);
    expect(loaded.entryToEffect?.paths).toHaveLength(3);
  });

  it("rejects provider thresholds that are not selected by the fixture", () => {
    expect(() =>
      evaluationOracleSchema.parse({
        ...oracle,
        thresholds: {
          ...oracle.thresholds,
          "typescript-fallback": oracle.thresholds["native-tree-sitter"],
        },
      }),
    ).toThrow("Threshold configured for unselected provider typescript-fallback");
  });

  it("rejects entry-to-effect paths that do not resolve to a terminal relation", () => {
    expect(() =>
      evaluationOracleSchema.parse({
        ...oracle,
        entryToEffect: {
          entrypoints: [
            {
              id: "entry",
              registration: { path: "src/a.ts", startLine: 1 },
              target: { path: "src/a.ts", symbol: "entry" },
            },
          ],
          relations: [
            {
              id: "call",
              kind: "call",
              source: { path: "src/a.ts", symbol: "entry" },
              target: { path: "src/b.ts", symbol: "target" },
              certainty: "exact",
              evidence: { path: "src/a.ts", startLine: 2 },
            },
          ],
          paths: [
            {
              id: "path",
              entrypoint: "entry",
              relations: ["call"],
              terminalRelation: "call",
              conditions: [],
              certainty: "exact",
            },
          ],
        },
      }),
    ).toThrow("must have kind terminal-effect");
  });

  it("only credits references produced by the measured compiler generation", () => {
    const parsed = reference("parsed", "src/b.ts");
    const parsedRead = { ...reference("parsed-read", "src/b.ts"), kind: "read" as const };
    const stale = {
      ...reference("stale", "src/b.ts"),
      producer: { id: "checker", version: "1", kind: "compiler" as const },
      generation: { sourceSignature: "old" },
      freshness: "stale" as const,
    };
    const current = {
      ...reference("current", "src/b.ts"),
      producer: { id: "checker", version: "1", kind: "compiler" as const },
      generation: { sourceSignature: "current" },
      freshness: "unverified" as const,
    };
    const currentRead = { ...current, id: "current-read", kind: "read" as const };

    const scoped = compilerPipelineFacts(
      batch([], [parsed, parsedRead, stale, current, currentRead]),
      "current",
    );

    expect(scoped.edges.map((edge) => edge.id)).toEqual(["current", "current-read"]);
  });

  it("credits resolved SCIP occurrence roles as references", () => {
    const read = { ...reference("read", "src/b.ts"), kind: "read" as const };

    expect(scoreFactBatch(batch([], [read]), oracle).references).toMatchObject({
      truePositives: 1,
      precision: 1,
      recall: 1,
    });
  });

  it("treats an unmatched official SCIP filter as missing validation", () => {
    const assertions = scipTestAssertions(
      "✓ src/main.ts (5 assertions)\n✓ src/store.ts (2 assertions)\n",
    );

    expect(assertions).toEqual([
      { path: "src/main.ts", count: 5 },
      { path: "src/store.ts", count: 2 },
    ]);
    expect(missingScipTestFiles(["src/main.ts", "src/typo.ts"], assertions)).toEqual([
      "src/typo.ts",
    ]);
  });

  it("uses provider-native SCIP document separators while comparing portable paths", () => {
    expect(scipDocumentFilter("./arena/effects.py", "\\")).toBe("arena\\effects.py");
    const assertions = scipTestAssertions("✓ arena\\effects.py (1 assertion)\n");
    expect(assertions).toEqual([
      { path: "arena/effects.py", count: 1 },
    ]);
    expect(missingScipTestFiles(["arena/effects.py"], assertions)).toEqual([]);
  });

  it("enforces the SCIP count bounds declared by the oracle", () => {
    expect(
      scipConstraintFailures(
        { documents: 1, definitions: 0, references: 0 },
        {
          documents: 2,
          minimumDefinitions: 1,
          minimumReferences: 1,
          commentSyntax: "//",
          testFiles: ["src/a.ts"],
        },
      ),
    ).toEqual([
      "SCIP indexed 1 documents; expected 2",
      "SCIP indexed 0 definitions; minimum is 1",
      "SCIP indexed 0 references; minimum is 1",
    ]);
  });

  it.skipIf(!loadNative())("rejects a checker pipeline when the checker does no work", async () => {
    const fixture = fileURLToPath(
      new URL("../../fixtures/eval/typescript-entry-effect/", import.meta.url),
    );
    const altered = await mkdtemp(join(tmpdir(), "sdlc-eval-no-checker-config-"));
    await cp(fixture, altered, { recursive: true });
    await rename(join(altered, "tsconfig.json"), join(altered, "tsconfig.disabled"));

    try {
      await expect(
        runEvaluationWorker("native-plus-typescript-checker", altered, null),
      ).rejects.toThrow("TypeScript checker cold run did not run");
    } finally {
      await rm(altered, { recursive: true, force: true });
    }
  });

  it("rejects a worker provider that the fixture did not select", async () => {
    const fixture = fileURLToPath(
      new URL("../../fixtures/eval/typescript-entry-effect/", import.meta.url),
    );

    await expect(runEvaluationWorker("scip-python", fixture, null)).rejects.toThrow(
      "Provider scip-python is not selected",
    );
  });
});

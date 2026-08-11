import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { FactBatch } from "../facts/model.js";

const metricThresholdSchema = z
  .object({
    minimumPrecision: z.number().min(0).max(1).optional(),
    minimumRecall: z.number().min(0).max(1).optional(),
    maximumFalsePositives: z.number().int().nonnegative().optional(),
    maximumMissing: z.number().int().nonnegative().optional(),
  })
  .strict();

const providerThresholdSchema = z
  .object({
    symbols: metricThresholdSchema,
    references: metricThresholdSchema,
  })
  .strict();

export const evaluationOracleSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenario: z.string().min(1),
    features: z.array(z.string().min(1)).min(1),
    change: z
      .object({
        path: z.string().min(1),
        append: z.string().min(1),
      })
      .strict(),
    symbols: z
      .array(
        z
          .object({
            path: z.string().min(1),
            name: z.string().min(1),
            startLine: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1),
    references: z.array(
      z
        .object({
          sourcePath: z.string().min(1),
          targetPath: z.string().min(1),
          targetSymbol: z.string().min(1),
        })
        .strict(),
    ),
    thresholds: z.record(z.string().min(1), providerThresholdSchema),
    scip: z
      .object({
        documents: z.number().int().nonnegative(),
        minimumDefinitions: z.number().int().nonnegative(),
        minimumReferences: z.number().int().nonnegative(),
        testFiles: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

export type EvaluationOracle = z.infer<typeof evaluationOracleSchema>;
export type MetricThreshold = z.infer<typeof metricThresholdSchema>;
export type ProviderThreshold = z.infer<typeof providerThresholdSchema>;
export type ExpectedSymbol = EvaluationOracle["symbols"][number];
export type ExpectedReference = EvaluationOracle["references"][number];

export interface MetricScore<T> {
  expected: number;
  actual: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Null means the provider returned no candidates in the selected scope. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  missing: T[];
  unexpected: T[];
}

export interface FactScores {
  symbols: MetricScore<ExpectedSymbol>;
  references: MetricScore<ExpectedReference>;
}

export async function loadEvaluationOracle(path: string): Promise<EvaluationOracle> {
  return evaluationOracleSchema.parse(JSON.parse(await readFile(path, "utf-8")));
}

function symbolKey(symbol: ExpectedSymbol): string {
  return `${symbol.path}\0${symbol.name}\0${symbol.startLine}`;
}

function referenceKey(reference: ExpectedReference): string {
  return `${reference.sourcePath}\0${reference.targetPath}\0${reference.targetSymbol}`;
}

function unique<T>(values: T[], key: (value: T) => string): Map<string, T> {
  return new Map(values.map((value) => [key(value), value]));
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

function score<T>(expectedValues: T[], actualValues: T[], key: (value: T) => string): MetricScore<T> {
  const expected = unique(expectedValues, key);
  const actual = unique(actualValues, key);
  const missing = [...expected]
    .filter(([id]) => !actual.has(id))
    .map(([, value]) => value);
  const unexpected = [...actual]
    .filter(([id]) => !expected.has(id))
    .map(([, value]) => value);
  const truePositives = expected.size - missing.length;
  const precision = ratio(truePositives, actual.size);
  const recall = ratio(truePositives, expected.size);
  const f1 =
    precision === null || recall === null
      ? null
      : precision + recall === 0
        ? 0
        : Number(((2 * precision * recall) / (precision + recall)).toFixed(6));
  return {
    expected: expected.size,
    actual: actual.size,
    truePositives,
    falsePositives: unexpected.length,
    falseNegatives: missing.length,
    precision,
    recall,
    f1,
    missing,
    unexpected,
  };
}

/**
 * Compare normalized product facts, not provider-native implementation detail.
 *
 * The checked-in oracle is intentionally targeted: its names and source paths
 * define the scored domain. Official `scip test` assertions cover exact SCIP
 * occurrence ranges; this layer compares the resolved facts every provider can
 * express through SDLC's common envelope.
 */
export function scoreFactBatch(batch: FactBatch, oracle: EvaluationOracle): FactScores {
  const symbolNames = new Set(oracle.symbols.map((symbol) => symbol.name));
  const symbolPaths = new Set(oracle.symbols.map((symbol) => symbol.path));
  const symbols: ExpectedSymbol[] = batch.nodes.flatMap((node) => {
    const path = node.anchor?.path;
    if (
      node.kind !== "symbol" ||
      !path ||
      !symbolPaths.has(path) ||
      !symbolNames.has(node.name)
    ) {
      return [];
    }
    return [{ path, name: node.name, startLine: node.anchor?.range?.startLine ?? -1 }];
  });

  const sourcePaths = new Set(oracle.references.map((reference) => reference.sourcePath));
  const targetSymbols = new Set(oracle.references.map((reference) => reference.targetSymbol));
  const references: ExpectedReference[] = batch.edges.flatMap((edge) => {
    const sourcePath = edge.source.path ?? edge.evidence.find((item) => item.anchor)?.anchor?.path;
    const targetPath = edge.target.path;
    const targetSymbol = edge.target.symbol;
    if (
      edge.kind !== "reference" ||
      !sourcePath ||
      !targetPath ||
      !targetSymbol ||
      !sourcePaths.has(sourcePath) ||
      !targetSymbols.has(targetSymbol)
    ) {
      return [];
    }
    return [{ sourcePath, targetPath, targetSymbol }];
  });

  return {
    symbols: score(oracle.symbols, symbols, symbolKey),
    references: score(oracle.references, references, referenceKey),
  };
}

function metricFailures(
  label: string,
  score: MetricScore<unknown>,
  threshold: MetricThreshold,
): string[] {
  const failures: string[] = [];
  if (
    threshold.minimumPrecision !== undefined &&
    (score.precision === null || score.precision < threshold.minimumPrecision)
  ) {
    failures.push(
      `${label} precision ${score.precision ?? "unavailable"} is below ${threshold.minimumPrecision}`,
    );
  }
  if (
    threshold.minimumRecall !== undefined &&
    (score.recall === null || score.recall < threshold.minimumRecall)
  ) {
    failures.push(`${label} recall ${score.recall ?? "unavailable"} is below ${threshold.minimumRecall}`);
  }
  if (
    threshold.maximumFalsePositives !== undefined &&
    score.falsePositives > threshold.maximumFalsePositives
  ) {
    failures.push(
      `${label} has ${score.falsePositives} false positives; maximum is ${threshold.maximumFalsePositives}`,
    );
  }
  if (threshold.maximumMissing !== undefined && score.falseNegatives > threshold.maximumMissing) {
    failures.push(
      `${label} is missing ${score.falseNegatives} facts; maximum is ${threshold.maximumMissing}`,
    );
  }
  return failures;
}

export function thresholdFailures(
  provider: string,
  scores: FactScores,
  oracle: EvaluationOracle,
): string[] {
  const threshold = oracle.thresholds[provider];
  if (!threshold) return [`No checked-in threshold exists for provider ${provider}.`];
  return [
    ...metricFailures("symbols", scores.symbols, threshold.symbols),
    ...metricFailures("references", scores.references, threshold.references),
  ];
}

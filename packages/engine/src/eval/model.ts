import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  CERTAINTY_CLASSES,
  EDGE_KINDS,
  type FactBatch,
  type FactEdge,
} from "../facts/model.js";

export const EVALUATION_PROVIDERS = [
  "native-tree-sitter",
  "native-plus-typescript-checker",
  "scip-typescript",
  "scip-python",
] as const;
export type EvaluationProvider = (typeof EVALUATION_PROVIDERS)[number];

export function isResolvedReferenceKind(kind: FactEdge["kind"]): boolean {
  return kind === "reference" || kind === "read" || kind === "write";
}

const evaluationProviderSchema = z.enum(EVALUATION_PROVIDERS);

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

const flowThresholdSchema = z
  .object({
    entrypoints: metricThresholdSchema,
    relations: metricThresholdSchema,
    paths: metricThresholdSchema,
  })
  .strict();

const scipExpectationSchema = z
  .object({
    documents: z.number().int().nonnegative(),
    minimumDefinitions: z.number().int().nonnegative(),
    minimumReferences: z.number().int().nonnegative(),
    commentSyntax: z.string().min(1),
    testFiles: z.array(z.string().min(1)).min(1),
  })
  .strict();

const flowEntitySchema = z.union([
  z
    .object({
      path: z.string().min(1),
      symbol: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      external: z.string().min(1),
    })
    .strict(),
]);

const flowEvidenceSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().nonnegative(),
    detail: z.string().min(1).optional(),
  })
  .strict();

const entryToEffectSchema = z
  .object({
    measuredProviders: z.array(evaluationProviderSchema),
    thresholds: flowThresholdSchema,
    entrypoints: z
      .array(
        z
          .object({
            id: z.string().min(1),
            registration: flowEvidenceSchema,
            target: flowEntitySchema,
          })
          .strict(),
      )
      .min(1),
    relations: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.enum(EDGE_KINDS),
            source: flowEntitySchema,
            target: flowEntitySchema,
            certainty: z.enum(CERTAINTY_CLASSES),
            evidence: flowEvidenceSchema,
          })
          .strict(),
      )
      .min(1),
    paths: z
      .array(
        z
          .object({
            id: z.string().min(1),
            entrypoint: z.string().min(1),
            relations: z.array(z.string().min(1)).min(1),
            terminalRelation: z.string().min(1),
            conditions: z.array(z.string().min(1)),
            certainty: z.enum(CERTAINTY_CLASSES),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((flow, context) => {
    const uniqueIds = (kind: string, ids: string[]): void => {
      const seen = new Set<string>();
      for (const [index, id] of ids.entries()) {
        if (seen.has(id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate ${kind} id: ${id}`,
            path: [kind, index, "id"],
          });
        }
        seen.add(id);
      }
    };
    uniqueIds("entrypoints", flow.entrypoints.map((entrypoint) => entrypoint.id));
    uniqueIds("relations", flow.relations.map((relation) => relation.id));
    uniqueIds("paths", flow.paths.map((path) => path.id));

    const entrypoints = new Set(flow.entrypoints.map((entrypoint) => entrypoint.id));
    const relations = new Map(flow.relations.map((relation) => [relation.id, relation]));
    for (const [pathIndex, path] of flow.paths.entries()) {
      if (!entrypoints.has(path.entrypoint)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown entrypoint id: ${path.entrypoint}`,
          path: ["paths", pathIndex, "entrypoint"],
        });
      }
      for (const [relationIndex, relation] of path.relations.entries()) {
        if (!relations.has(relation)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown relation id: ${relation}`,
            path: ["paths", pathIndex, "relations", relationIndex],
          });
        }
      }
      const terminal = relations.get(path.terminalRelation);
      if (!terminal) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown terminal relation id: ${path.terminalRelation}`,
          path: ["paths", pathIndex, "terminalRelation"],
        });
      } else if (terminal.kind !== "terminal-effect") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Terminal relation ${path.terminalRelation} must have kind terminal-effect.`,
          path: ["paths", pathIndex, "terminalRelation"],
        });
      }
      if (!path.relations.includes(path.terminalRelation)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Path must include its terminal relation: ${path.terminalRelation}`,
          path: ["paths", pathIndex, "relations"],
        });
      } else if (path.relations.at(-1) !== path.terminalRelation) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Path must end with its terminal relation: ${path.terminalRelation}`,
          path: ["paths", pathIndex, "relations"],
        });
      }
    }
  });

export const evaluationOracleSchema = z
  .object({
    schemaVersion: z.literal(2),
    scenario: z.string().min(1),
    languages: z.array(z.string().min(1)).min(1),
    features: z.array(z.string().min(1)).min(1),
    providers: z.array(evaluationProviderSchema).min(1),
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
    scip: z.record(evaluationProviderSchema, scipExpectationSchema).optional(),
    entryToEffect: entryToEffectSchema.optional(),
  })
  .strict()
  .superRefine((oracle, context) => {
    const providers = new Set(oracle.providers);
    if (providers.size !== oracle.providers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Evaluation providers must be unique.",
        path: ["providers"],
      });
    }
    const thresholdProviders = new Set(Object.keys(oracle.thresholds));
    const measuredFlowProviders = oracle.entryToEffect?.measuredProviders ?? [];
    if (new Set(measuredFlowProviders).size !== measuredFlowProviders.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Measured flow providers must be unique.",
        path: ["entryToEffect", "measuredProviders"],
      });
    }
    for (const provider of measuredFlowProviders) {
      if (!providers.has(provider)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Flow provider ${provider} is not selected by the fixture.`,
          path: ["entryToEffect", "measuredProviders"],
        });
      }
    }
    for (const provider of providers) {
      if (!thresholdProviders.has(provider)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing threshold for provider ${provider}.`,
          path: ["thresholds"],
        });
      }
    }
    for (const provider of thresholdProviders) {
      if (!providers.has(provider as EvaluationProvider)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Threshold configured for unselected provider ${provider}.`,
          path: ["thresholds", provider],
        });
      }
    }
    const scipProviders = [...providers].filter((provider) => provider.startsWith("scip-"));
    for (const provider of scipProviders) {
      if (!oracle.scip?.[provider]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `SCIP expectations are required when ${provider} is selected.`,
          path: ["scip", provider],
        });
      }
    }
    for (const provider of Object.keys(oracle.scip ?? {})) {
      if (!provider.startsWith("scip-") || !providers.has(provider as EvaluationProvider)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `SCIP expectations configured for unselected provider ${provider}.`,
          path: ["scip", provider],
        });
      }
    }
  });

export type EvaluationOracle = z.infer<typeof evaluationOracleSchema>;
export type ScipOracle = NonNullable<NonNullable<EvaluationOracle["scip"]>[EvaluationProvider]>;
export type EntryToEffectOracle = NonNullable<EvaluationOracle["entryToEffect"]>;
export type FlowThreshold = EntryToEffectOracle["thresholds"];
export type FlowEntity = EntryToEffectOracle["relations"][number]["source"];
export type ExpectedFlowEntrypoint = EntryToEffectOracle["entrypoints"][number];
export type ExpectedFlowRelation = EntryToEffectOracle["relations"][number];
export type ExpectedFlowPath = EntryToEffectOracle["paths"][number];
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

export function scoreMetric<T>(
  expectedValues: T[],
  actualValues: T[],
  key: (value: T) => string,
): MetricScore<T> {
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
      !isResolvedReferenceKind(edge.kind) ||
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
    symbols: scoreMetric(oracle.symbols, symbols, symbolKey),
    references: scoreMetric(oracle.references, references, referenceKey),
  };
}

export function metricThresholdFailures(
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
    ...metricThresholdFailures("symbols", scores.symbols, threshold.symbols),
    ...metricThresholdFailures("references", scores.references, threshold.references),
  ];
}

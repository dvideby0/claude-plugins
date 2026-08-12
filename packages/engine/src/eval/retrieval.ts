import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { access, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { z } from "zod";
import { closeDb, getDb, TASK_INTENTS } from "../db/db.js";
import { MEMORY_KINDS, remember } from "../memory/store.js";
import { buildTaskContext, type TaskContextBrief } from "../plan/task-context.js";
import { scan } from "../scan/scan.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const expectedEvidenceSchema = z
  .object({
    path: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (!evidence.path && !evidence.kind && !evidence.title) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected retrieval evidence needs a path, kind, or title.",
      });
    }
    if (evidence.symbol && !evidence.path) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A symbol expectation also needs its repository-relative path.",
        path: ["symbol"],
      });
    }
  });

const retrievalThresholdSchema = z
  .object({
    minimumSdlcRecallAtK: z.number().min(0).max(1),
    minimumSdlcEvidenceCoverage: z.number().min(0).max(1),
    maximumSdlcIrrelevantContextRate: z.number().min(0).max(1),
    maximumSdlcPackedTokens: z.number().int().positive(),
    minimumRecallDeltaVsAider: z.number().min(-1).max(1),
    minimumEvidenceCoverageDeltaVsAider: z.number().min(-1).max(1),
    maximumIrrelevantContextRateDeltaVsAider: z.number().min(-1).max(1),
    maximumPackedTokenRatioVsAider: z.number().positive(),
  })
  .strict();

const retrievalScenarioSchema = z
  .object({
    id: z.string().min(1),
    task: z.string().min(1),
    targets: z.array(z.string().min(1)).max(8),
    intent: z.enum(TASK_INTENTS),
    budgetBytes: z.number().int().min(6_000).max(100_000),
    rankK: z.number().int().min(1).max(100),
    relevantPaths: z.array(z.string().min(1)).min(1),
    requiredEvidence: z.array(expectedEvidenceSchema).min(1),
    thresholds: retrievalThresholdSchema,
  })
  .strict()
  .superRefine((scenario, context) => {
    if (new Set(scenario.targets).size !== scenario.targets.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Explicit targets must be unique.",
        path: ["targets"],
      });
    }
    if (new Set(scenario.relevantPaths).size !== scenario.relevantPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Relevant paths must be unique.",
        path: ["relevantPaths"],
      });
    }
    for (const [index, evidence] of scenario.requiredEvidence.entries()) {
      if (evidence.path && !scenario.relevantPaths.includes(evidence.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Required evidence path ${evidence.path} is not listed as relevant.`,
          path: ["requiredEvidence", index, "path"],
        });
      }
    }
    const evidenceKeys = scenario.requiredEvidence.map((evidence) =>
      JSON.stringify([evidence.path, evidence.symbol, evidence.kind, evidence.title]),
    );
    if (new Set(evidenceKeys).size !== evidenceKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Required evidence entries must be unique.",
        path: ["requiredEvidence"],
      });
    }
  });

export const retrievalOracleSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenario: z.string().min(1),
    sourceDirectory: z.string().min(1),
    tokenizer: z
      .object({
        library: z.literal("js-tiktoken"),
        version: z.literal("1.0.21"),
        encoding: z.literal("o200k_base"),
      })
      .strict(),
    baseline: z
      .object({
        artifact: z.string().min(1),
        sourceSha256: sha256Schema,
        artifactSha256: sha256Schema,
        mapTokens: z.number().int().positive(),
        generator: z
          .object({
            id: z.literal("aider-chat"),
            version: z.string().min(1),
            model: z.string().min(1),
            command: z.array(z.string().min(1)).min(1),
            normalization: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    setup: z
      .object({
        memories: z.array(
          z
            .object({
              kind: z.enum(MEMORY_KINDS),
              title: z.string().min(1),
              body: z.string(),
              anchors: z.array(
                z
                  .object({
                    path: z.string().min(1),
                    symbol: z.string().min(1).optional(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict(),
    promotion: z
      .object({
        eligible: z.boolean(),
        blockers: z.array(z.string().min(1)),
      })
      .strict()
      .superRefine((promotion, context) => {
        if (promotion.eligible && promotion.blockers.length > 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A promotion-eligible corpus cannot retain promotion blockers.",
            path: ["blockers"],
          });
        }
        if (!promotion.eligible && promotion.blockers.length === 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An experimental corpus must say what still blocks promotion.",
            path: ["blockers"],
          });
        }
      }),
    scenarios: z.array(retrievalScenarioSchema).min(1),
  })
  .strict()
  .superRefine((oracle, context) => {
    const ids = oracle.scenarios.map((scenario) => scenario.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Retrieval scenario ids must be unique.",
        path: ["scenarios"],
      });
    }
    for (const [index, scenario] of oracle.scenarios.entries()) {
      if (scenario.thresholds.maximumSdlcPackedTokens > oracle.baseline.mapTokens) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The SDLC token ceiling cannot exceed the Aider map-token target.",
          path: ["scenarios", index, "thresholds", "maximumSdlcPackedTokens"],
        });
      }
    }
  });

export type RetrievalOracle = z.infer<typeof retrievalOracleSchema>;
export type RetrievalScenario = RetrievalOracle["scenarios"][number];
export type ExpectedRetrievalEvidence = RetrievalScenario["requiredEvidence"][number];

export interface EvidenceUnit {
  path: string | null;
  symbol: string | null;
  kind: string;
  title: string;
  content: string;
}

export interface RetrievalMetrics {
  recallAtK: number;
  evidenceCoverage: number;
  irrelevantContextRate: number | null;
  packedBytes: number;
  packedTokens: number;
  withinBudget: boolean;
  rankedPaths: string[];
  matchedEvidence: ExpectedRetrievalEvidence[];
  missingEvidence: ExpectedRetrievalEvidence[];
}

export interface RetrievalScenarioReport {
  id: string;
  task: string;
  rankK: number;
  budgetBytes: number;
  passed: boolean;
  failures: string[];
  sdlc: RetrievalMetrics;
  aider: RetrievalMetrics;
  comparison: {
    recallAtKDelta: number;
    evidenceCoverageDelta: number;
    irrelevantContextRateDelta: number | null;
    packedTokenRatio: number | null;
  };
}

export interface RetrievalEvaluationReport {
  schemaVersion: 1;
  scenario: string;
  fixture: string;
  passed: boolean;
  failures: string[];
  sourceSha256: string;
  baseline: RetrievalOracle["baseline"] & { packedBytes: number; packedTokens: number };
  tokenizer: RetrievalOracle["tokenizer"];
  promotion: RetrievalOracle["promotion"] & {
    status: "eligible" | "keep-experimental";
  };
  scenarios: RetrievalScenarioReport[];
}

const tokenizer = new Tiktoken(o200kBase);

function normalizedText(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function textSha256(value: string): string {
  return createHash("sha256").update(normalizedText(value), "utf8").digest("hex");
}

function containedFixturePath(fixture: string, candidate: string, label: string): string {
  const path = resolve(fixture, candidate);
  const portable = relative(fixture, path);
  if (portable === ".." || portable.startsWith(`..${sep}`) || isAbsolute(portable)) {
    throw new Error(`${label} must stay inside the retrieval fixture.`);
  }
  return path;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files;
}

/** Stable, text-normalized digest for the exact source tree shown to Aider. */
export async function retrievalSourceSha256(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await sourceFiles(root)) {
    const portable = relative(root, path).replaceAll("\\", "/");
    const content = normalizedText(await readFile(path, "utf8"));
    hash.update(`${Buffer.byteLength(portable, "utf8")}:`, "utf8");
    hash.update(portable, "utf8");
    hash.update(`${Buffer.byteLength(content, "utf8")}:`, "utf8");
    hash.update(content, "utf8");
  }
  return hash.digest("hex");
}

export async function loadRetrievalOracle(path: string): Promise<RetrievalOracle> {
  return retrievalOracleSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function delta(left: number, right: number): number {
  return Number((left - right).toFixed(6));
}

function tokenCount(context: string): number {
  return tokenizer.encode(context).length;
}

function uniqueRankedPaths(evidence: readonly EvidenceUnit[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!item.path || seen.has(item.path)) continue;
    seen.add(item.path);
    paths.push(item.path);
  }
  return paths;
}

function matchesExpectation(item: EvidenceUnit, expected: ExpectedRetrievalEvidence): boolean {
  if (expected.path && item.path !== expected.path) return false;
  if (expected.symbol && item.symbol !== expected.symbol && !item.content.includes(expected.symbol)) {
    return false;
  }
  if (expected.kind && item.kind !== expected.kind) return false;
  if (expected.title && item.title !== expected.title) return false;
  return true;
}

export function scoreRetrievalContext(
  context: string,
  evidence: readonly EvidenceUnit[],
  scenario: RetrievalScenario,
): RetrievalMetrics {
  const rankedPaths = uniqueRankedPaths(evidence);
  const relevant = new Set(scenario.relevantPaths);
  const topPaths = new Set(rankedPaths.slice(0, scenario.rankK));
  const matchedEvidence = scenario.requiredEvidence.filter((expected) =>
    evidence.some((item) => matchesExpectation(item, expected)),
  );
  const missingEvidence = scenario.requiredEvidence.filter(
    (expected) => !matchedEvidence.includes(expected),
  );
  const irrelevant = rankedPaths.filter((path) => !relevant.has(path)).length;
  const packedBytes = Buffer.byteLength(context, "utf8");
  return {
    recallAtK: ratio(
      scenario.relevantPaths.filter((path) => topPaths.has(path)).length,
      scenario.relevantPaths.length,
    ),
    evidenceCoverage: ratio(matchedEvidence.length, scenario.requiredEvidence.length),
    irrelevantContextRate: rankedPaths.length === 0 ? null : ratio(irrelevant, rankedPaths.length),
    packedBytes,
    packedTokens: tokenCount(context),
    withinBudget: packedBytes <= scenario.budgetBytes,
    rankedPaths,
    matchedEvidence,
    missingEvidence,
  };
}

function sdlcEvidence(brief: TaskContextBrief): EvidenceUnit[] {
  return brief.evidence.map((item) => ({
    path: item.source?.path ?? null,
    symbol: item.source?.symbol ?? null,
    kind: item.kind,
    title: item.title,
    content: item.source ? `${item.source.path}\n${item.source.symbol ?? ""}` : item.title,
  }));
}

/** Parse file blocks from Aider's own formatted repo-map without reproducing its ranking. */
export function aiderEvidence(context: string, knownPaths: readonly string[]): EvidenceUnit[] {
  const known = new Set(knownPaths);
  const lines = normalizedText(context).split("\n");
  const headers: Array<{ index: number; path: string }> = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const path = line.endsWith(":") ? line.slice(0, -1) : line;
    if (known.has(path)) headers.push({ index, path });
  }
  return headers.map((header, index) => {
    const end = headers[index + 1]?.index ?? lines.length;
    return {
      path: header.path,
      symbol: null,
      kind: "source-map",
      title: header.path,
      content: lines.slice(header.index, end).join("\n"),
    };
  });
}

function comparisonFailures(
  scenario: RetrievalScenario,
  sdlc: RetrievalMetrics,
  aider: RetrievalMetrics,
): string[] {
  const failures: string[] = [];
  const threshold = scenario.thresholds;
  if (!sdlc.withinBudget) {
    failures.push(`SDLC packed ${sdlc.packedBytes} bytes beyond the ${scenario.budgetBytes}-byte budget.`);
  }
  if (!aider.withinBudget) {
    failures.push(`Aider packed ${aider.packedBytes} bytes beyond the ${scenario.budgetBytes}-byte budget.`);
  }
  if (sdlc.recallAtK < threshold.minimumSdlcRecallAtK) {
    failures.push(
      `SDLC recall@${scenario.rankK} ${sdlc.recallAtK} is below ${threshold.minimumSdlcRecallAtK}.`,
    );
  }
  if (sdlc.evidenceCoverage < threshold.minimumSdlcEvidenceCoverage) {
    failures.push(
      `SDLC evidence coverage ${sdlc.evidenceCoverage} is below ${threshold.minimumSdlcEvidenceCoverage}.`,
    );
  }
  if (
    sdlc.irrelevantContextRate === null ||
    sdlc.irrelevantContextRate > threshold.maximumSdlcIrrelevantContextRate
  ) {
    failures.push(
      `SDLC irrelevant-context rate ${sdlc.irrelevantContextRate ?? "unavailable"} exceeds ${threshold.maximumSdlcIrrelevantContextRate}.`,
    );
  }
  if (sdlc.packedTokens > threshold.maximumSdlcPackedTokens) {
    failures.push(
      `SDLC packed ${sdlc.packedTokens} tokens beyond the ${threshold.maximumSdlcPackedTokens}-token ceiling.`,
    );
  }
  if (delta(sdlc.recallAtK, aider.recallAtK) < threshold.minimumRecallDeltaVsAider) {
    failures.push(
      `SDLC recall delta versus Aider ${delta(sdlc.recallAtK, aider.recallAtK)} is below ${threshold.minimumRecallDeltaVsAider}.`,
    );
  }
  if (
    delta(sdlc.evidenceCoverage, aider.evidenceCoverage) <
    threshold.minimumEvidenceCoverageDeltaVsAider
  ) {
    failures.push(
      `SDLC evidence-coverage delta versus Aider ${delta(sdlc.evidenceCoverage, aider.evidenceCoverage)} is below ${threshold.minimumEvidenceCoverageDeltaVsAider}.`,
    );
  }
  if (
    sdlc.irrelevantContextRate === null ||
    aider.irrelevantContextRate === null ||
    delta(sdlc.irrelevantContextRate, aider.irrelevantContextRate) >
      threshold.maximumIrrelevantContextRateDeltaVsAider
  ) {
    failures.push(
      `SDLC irrelevant-context delta versus Aider ${
        sdlc.irrelevantContextRate === null || aider.irrelevantContextRate === null
          ? "unavailable"
          : delta(sdlc.irrelevantContextRate, aider.irrelevantContextRate)
      } exceeds ${threshold.maximumIrrelevantContextRateDeltaVsAider}.`,
    );
  }
  const packedTokenRatio =
    aider.packedTokens === 0 ? null : sdlc.packedTokens / aider.packedTokens;
  if (
    packedTokenRatio === null ||
    packedTokenRatio > threshold.maximumPackedTokenRatioVsAider
  ) {
    failures.push(
      `SDLC packed-token ratio versus Aider ${
        packedTokenRatio === null ? "unavailable" : Number(packedTokenRatio.toFixed(6))
      } exceeds ${threshold.maximumPackedTokenRatioVsAider}.`,
    );
  }
  return failures;
}

export async function runRetrievalEvaluation(
  fixtureRoot: string,
): Promise<RetrievalEvaluationReport> {
  const fixture = resolve(fixtureRoot);
  const oracle = await loadRetrievalOracle(join(fixture, "oracle.json"));
  const sourceRoot = containedFixturePath(fixture, oracle.sourceDirectory, "Source directory");
  const baselinePath = containedFixturePath(fixture, oracle.baseline.artifact, "Baseline artifact");
  const [sourceSha256, baselineContext, knownSourceFiles] = await Promise.all([
    retrievalSourceSha256(sourceRoot),
    readFile(baselinePath, "utf8").then(normalizedText),
    sourceFiles(sourceRoot),
  ]);
  if (sourceSha256 !== oracle.baseline.sourceSha256) {
    throw new Error(
      `Retrieval fixture source digest ${sourceSha256} does not match the Aider baseline ${oracle.baseline.sourceSha256}; regenerate the pinned baseline.`,
    );
  }
  const artifactSha256 = textSha256(baselineContext);
  if (artifactSha256 !== oracle.baseline.artifactSha256) {
    throw new Error(
      `Aider baseline digest ${artifactSha256} does not match ${oracle.baseline.artifactSha256}; restore or regenerate the artifact.`,
    );
  }

  const knownPaths = knownSourceFiles.map((path) => relative(sourceRoot, path).replaceAll("\\", "/"));
  const baselineEvidence = aiderEvidence(baselineContext, knownPaths);
  const baselinePackedTokens = tokenCount(baselineContext);
  if (baselinePackedTokens > oracle.baseline.mapTokens) {
    throw new Error(
      `Aider baseline packed ${baselinePackedTokens} tokens beyond its ${oracle.baseline.mapTokens}-token target.`,
    );
  }
  const previousState = process.env.SDLC_HOME;
  const state = await mkdtemp(join(tmpdir(), "sdlc-retrieval-state-"));
  let project: string | null = null;
  let environmentChanged = false;
  try {
    project = await mkdtemp(join(tmpdir(), "sdlc-retrieval-source-"));
    process.env.SDLC_HOME = state;
    environmentChanged = true;
    await cp(sourceRoot, project, { recursive: true });
    await scan(project, { full: true, kind: "evaluation-retrieval" });
    const db = await getDb(project);
    for (const memory of oracle.setup.memories) remember(db, { ...memory, source: "eval-oracle" });

    const scenarios: RetrievalScenarioReport[] = [];
    for (const scenario of oracle.scenarios) {
      const brief = await buildTaskContext(db, project, {
        task: scenario.task,
        targets: scenario.targets,
        intent: scenario.intent,
        budgetBytes: scenario.budgetBytes,
      });
      const sdlcContext = JSON.stringify(brief, null, 2);
      const sdlc = scoreRetrievalContext(sdlcContext, sdlcEvidence(brief), scenario);
      const aider = scoreRetrievalContext(baselineContext, baselineEvidence, scenario);
      const failures = comparisonFailures(scenario, sdlc, aider);
      scenarios.push({
        id: scenario.id,
        task: scenario.task,
        rankK: scenario.rankK,
        budgetBytes: scenario.budgetBytes,
        passed: failures.length === 0,
        failures,
        sdlc,
        aider,
        comparison: {
          recallAtKDelta: delta(sdlc.recallAtK, aider.recallAtK),
          evidenceCoverageDelta: delta(sdlc.evidenceCoverage, aider.evidenceCoverage),
          irrelevantContextRateDelta:
            sdlc.irrelevantContextRate === null || aider.irrelevantContextRate === null
              ? null
              : delta(sdlc.irrelevantContextRate, aider.irrelevantContextRate),
          packedTokenRatio:
            aider.packedTokens === 0
              ? null
              : Number((sdlc.packedTokens / aider.packedTokens).toFixed(6)),
        },
      });
    }
    const failures = scenarios.flatMap((scenario) =>
      scenario.failures.map((failure) => `${scenario.id}: ${failure}`),
    );
    const passed = failures.length === 0;
    return {
      schemaVersion: 1,
      scenario: oracle.scenario,
      fixture: basename(fixture),
      passed,
      failures,
      sourceSha256,
      baseline: {
        ...oracle.baseline,
        packedBytes: Buffer.byteLength(baselineContext, "utf8"),
        packedTokens: baselinePackedTokens,
      },
      tokenizer: oracle.tokenizer,
      promotion: {
        ...oracle.promotion,
        status: passed && oracle.promotion.eligible ? "eligible" : "keep-experimental",
      },
      scenarios,
    };
  } finally {
    try {
      if (project) await closeDb(project);
    } finally {
      if (environmentChanged) {
        if (previousState === undefined) delete process.env.SDLC_HOME;
        else process.env.SDLC_HOME = previousState;
      }
      await Promise.all([
        ...(project ? [rm(project, { recursive: true, force: true })] : []),
        rm(state, { recursive: true, force: true }),
      ]);
    }
  }
}

export async function runRetrievalCorpus(selected: string | null = null): Promise<{
  passed: boolean;
  failures: string[];
  scenarios: RetrievalEvaluationReport[];
}> {
  const root = fileURLToPath(new URL("../../fixtures/retrieval/", import.meta.url));
  const fixturePaths = selected
    ? [isAbsolute(selected) ? selected : join(root, selected)]
    : (
        await Promise.all(
          (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(async (entry) => {
              const path = join(root, entry.name);
              try {
                await access(join(path, "oracle.json"));
                return path;
              } catch {
                return null;
              }
            }),
        )
      ).filter((path): path is string => path !== null);
  const scenarios: RetrievalEvaluationReport[] = [];
  for (const fixture of fixturePaths) scenarios.push(await runRetrievalEvaluation(fixture));
  if (scenarios.length === 0) throw new Error(`No retrieval fixtures found under ${root}.`);
  const failures = scenarios.flatMap((scenario) =>
    scenario.failures.map((failure) => `${scenario.scenario}: ${failure}`),
  );
  return { passed: failures.length === 0, failures, scenarios };
}

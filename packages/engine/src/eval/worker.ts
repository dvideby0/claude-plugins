import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../db/db.js";
import type { FactBatch } from "../facts/model.js";
import type { TypedResult } from "../graph/typed.js";
import { exec, platformCommand } from "../lib/exec.js";
import { resolveWorkspacePath } from "../lib/workspace-path.js";
import { scan, type ScanResult } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { indexedSourceSignature } from "../scan/signature.js";
import {
  EVALUATION_PROVIDERS,
  isResolvedReferenceKind,
  loadEvaluationOracle,
  scoreFactBatch,
  thresholdFailures,
  type EvaluationProvider,
  type FactScores,
  type ScipOracle,
} from "./model.js";
import {
  executionFlowCandidate,
  flowAcceptanceFailures,
  scoreFlowGraph,
  type CandidateFlowGraph,
  type FlowScores,
} from "./flow.js";

const nodeRequire = createRequire(import.meta.url);
const MAX_SCIP_INDEX_BYTES = 128 * 1024 * 1024;

interface ScipPythonPackage {
  version: string;
  bin: string | Record<string, string>;
}

function bundledScipPython(): { cli: string; version: string } {
  const packagePath = nodeRequire.resolve("@sourcegraph/scip-python/package.json");
  const pkg = nodeRequire(packagePath) as ScipPythonPackage;
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["scip-python"];
  if (!bin) throw new Error("The pinned SCIP-Python package has no scip-python executable.");
  return { cli: join(dirname(packagePath), bin), version: pkg.version };
}

interface Timed<T> {
  value: T;
  durationMs: number;
}

export interface EvaluationTimings {
  coldMs: number;
  warmMs: number | null;
  changedFileMs: number | null;
  scope: string;
}

export interface OfficialScipTest {
  status: "passed" | "failed" | "unavailable";
  command: string | null;
  exitCode: number | null;
  spawnFailed: boolean;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  assertions: Array<{ path: string; count: number }>;
  missingFiles: string[];
}

export interface ScipCounts {
  documents: number;
  definitions: number;
  references: number;
}

export interface ProviderEvaluationReport {
  provider: EvaluationProvider;
  scenario: string;
  passed: boolean;
  failures: string[];
  scores: FactScores;
  timings: EvaluationTimings;
  storage: {
    workspaceDbBytes: number;
    providerArtifactBytes: number | null;
  };
  memory: {
    runnerPeakRssBytes: number;
    scope: string;
  };
  officialScipTest: OfficialScipTest | null;
  scipCounts: ScipCounts | null;
  flow: {
    scores: FlowScores;
    candidate: { entrypoints: number; relations: number; paths: number };
    diagnostics: string[];
  } | null;
  sourceEngine: ScanResult["engine"];
  unmeasured: string[];
}

async function timed<T>(action: () => T | Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  const value = await action();
  return { value, durationMs: Number((performance.now() - started).toFixed(3)) };
}

async function fileBytes(path: string): Promise<number> {
  return (await stat(path)).size;
}

function workspaceId(scenario: string, provider: string): string {
  return createHash("sha256").update(`${scenario}\0${provider}`).digest("hex").slice(0, 12);
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Match the separator spelling emitted by Node-based SCIP providers. */
export function scipDocumentFilter(path: string, separator = sep): string {
  return portablePath(path).replaceAll("/", separator);
}

/** Parse the stable one-line summaries emitted by the official SCIP tester. */
export function scipTestAssertions(stdout: string): Array<{ path: string; count: number }> {
  const assertions = new Map<string, number>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    // Be tolerant of color if a future CLI decides to emit it without a TTY.
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "").trim();
    const match = /^[✓✔]\s+(.+?)\s+\((\d+)\s+assertions?\)$/.exec(line);
    if (!match) continue;
    assertions.set(portablePath(match[1]!), Number(match[2]));
  }
  return [...assertions].map(([path, count]) => ({ path, count }));
}

export function missingScipTestFiles(
  testFiles: string[],
  assertions: Array<{ path: string; count: number }>,
): string[] {
  const assertionPaths = new Set(
    assertions.filter((assertion) => assertion.count > 0).map((assertion) => assertion.path),
  );
  return testFiles.map(portablePath).filter((path) => !assertionPaths.has(path));
}

function requireTypedRun(label: string, result: TypedResult): void {
  if (result.ran) return;
  throw new Error(
    `TypeScript checker ${label} did not run: ${result.reason ?? "no reason reported"}`,
  );
}

/**
 * The checker is an upgrade layered over the native syntax index. Symbols are
 * therefore scored as a composite pipeline, while resolved references must be
 * attributable to the checker run for the exact generation being measured.
 */
export function compilerPipelineFacts(batch: FactBatch, sourceSignature: string): FactBatch {
  return {
    ...batch,
    edges: batch.edges.filter(
      (edge) =>
        !isResolvedReferenceKind(edge.kind) ||
        (edge.producer.kind === "compiler" &&
          edge.generation.sourceSignature === sourceSignature &&
          edge.freshness !== "stale"),
    ),
  };
}

export function scipConstraintFailures(
  counts: ScipCounts,
  expected: ScipOracle,
): string[] {
  const failures: string[] = [];
  if (counts.documents !== expected.documents) {
    failures.push(`SCIP indexed ${counts.documents} documents; expected ${expected.documents}`);
  }
  if (counts.definitions < expected.minimumDefinitions) {
    failures.push(
      `SCIP indexed ${counts.definitions} definitions; minimum is ${expected.minimumDefinitions}`,
    );
  }
  if (counts.references < expected.minimumReferences) {
    failures.push(
      `SCIP indexed ${counts.references} references; minimum is ${expected.minimumReferences}`,
    );
  }
  return failures;
}

async function officialScipTest(
  scipCli: string | null,
  projectRoot: string,
  indexPath: string,
  commentSyntax: string,
  testFiles: string[],
): Promise<OfficialScipTest> {
  if (!scipCli) {
    return {
      status: "unavailable",
      command: null,
      exitCode: null,
      spawnFailed: false,
      timedOut: false,
      truncated: false,
      stdout: "",
      stderr: "",
      assertions: [],
      missingFiles: [],
    };
  }
  const args = [
    "test",
    "--from",
    indexPath,
    "--comment-syntax",
    commentSyntax,
    ...testFiles.flatMap((path) => ["--filter", scipDocumentFilter(path)]),
    "--check-documents",
    // v0.9.0 documents the invocation directory as implicit, but its command
    // passes an empty string to WalkDir unless a positional directory exists.
    ".",
  ];
  const command = platformCommand(scipCli, args);
  const result = await exec(command.command, command.args, {
    cwd: projectRoot,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  const stdout = result.stdout.trim();
  const assertions = scipTestAssertions(stdout);
  const missingFiles = missingScipTestFiles(testFiles, assertions);
  return {
    status:
      !result.spawnFailed &&
      !result.timedOut &&
      !result.truncated &&
      result.exitCode === 0 &&
      missingFiles.length === 0
        ? "passed"
        : "failed",
    command: [scipCli, ...args].join(" "),
    exitCode: result.exitCode,
    spawnFailed: result.spawnFailed,
    timedOut: result.timedOut,
    truncated: result.truncated,
    stdout,
    stderr: result.stderr.trim(),
    assertions,
    missingFiles,
  };
}

/** Run one provider in an isolated process so its peak RSS is meaningful. */
export async function runEvaluationWorker(
  provider: EvaluationProvider,
  fixtureRoot: string,
  scipCli: string | null,
): Promise<ProviderEvaluationReport> {
  const fixture = resolve(fixtureRoot);
  const oracle = await loadEvaluationOracle(join(fixture, "oracle.json"));
  if (!oracle.providers.includes(provider)) {
    throw new Error(`Provider ${provider} is not selected by scenario ${oracle.scenario}.`);
  }
  const previousStateDir = process.env.SDLC_HOME;
  const evaluationState = await mkdtemp(join(tmpdir(), `sdlc-eval-state-${provider}-`));
  process.env.SDLC_HOME = evaluationState;
  let cleanupProject: string | null = null;
  let cleanupArtifacts: string | null = null;
  let dbOpened = false;
  let workspaceDbPath: string | null = null;
  let batch: FactBatch;
  let timings: EvaluationTimings;
  let official: OfficialScipTest | null = null;
  let scipCounts: ProviderEvaluationReport["scipCounts"] = null;
  const providerFailures: string[] = [];
  let providerArtifactBytes: number | null = null;
  let sourceEngine: ScanResult["engine"] = "native";

  try {
    // Setup belongs inside the cleanup boundary: if either temporary directory
    // or the fixture copy fails, SDLC_HOME still has to be restored.
    const project = await mkdtemp(join(tmpdir(), `sdlc-eval-${provider}-`));
    cleanupProject = project;
    const artifacts = await mkdtemp(join(tmpdir(), `sdlc-eval-artifacts-${provider}-`));
    cleanupArtifacts = artifacts;
    await cp(fixture, project, { recursive: true });

    if (provider === "native-tree-sitter") {
      const { projectLegacyFacts } = await import("../facts/legacy.js");
      const cold = await timed(() => scan(project, { full: true, kind: "evaluation-cold" }));
      sourceEngine = cold.value.engine;
      const warm = await timed(() => scan(project, { kind: "evaluation-warm" }));
      await appendFile(resolveWorkspacePath(project, oracle.change.path), oracle.change.append);
      const changed = await timed(() => scan(project, { kind: "evaluation-one-file-change" }));
      const db = await getDb(project);
      dbOpened = true;
      workspaceDbPath = db.path;
      batch = projectLegacyFacts(db, {
        workspaceId: workspaceId(oracle.scenario, provider),
        generatedAt: "1970-01-01T00:00:00.000Z",
      });
      timings = {
        coldMs: cold.durationMs,
        warmMs: warm.durationMs,
        changedFileMs: changed.durationMs,
        scope: "repository scan and native workspace-store update",
      };
    } else if (provider === "native-plus-typescript-checker") {
      const [{ projectLegacyFacts }, { resolveTypes }] = await Promise.all([
        import("../facts/legacy.js"),
        import("../graph/typed.js"),
      ]);
      const scanned = await scan(project, { full: true, kind: "evaluation-compiler-setup" });
      sourceEngine = scanned.engine;
      const db = await getDb(project);
      dbOpened = true;
      workspaceDbPath = db.path;
      const cold = await timed(() => resolveTypes(db, project));
      requireTypedRun("cold run", cold.value);
      const warm = await timed(() => resolveTypes(db, project));
      requireTypedRun("warm run", warm.value);
      await appendFile(resolveWorkspacePath(project, oracle.change.path), oracle.change.append);
      await scan(project, { kind: "evaluation-compiler-one-file-setup" });
      const changed = await timed(() => resolveTypes(db, project));
      requireTypedRun("one-file-change run", changed.value);
      const sourceSignature = indexedSourceSignature(db);
      batch = compilerPipelineFacts(
        projectLegacyFacts(db, {
          workspaceId: workspaceId(oracle.scenario, provider),
          generatedAt: "1970-01-01T00:00:00.000Z",
        }),
        sourceSignature,
      );
      timings = {
        coldMs: cold.durationMs,
        warmMs: warm.durationMs,
        changedFileMs: changed.durationMs,
        scope: "TypeScript checker prototype after syntax indexing",
      };
    } else if (provider === "scip-typescript") {
      const scipExpected = oracle.scip?.[provider];
      if (!scipExpected) {
        throw new Error("SCIP evaluation requires checked-in SCIP expectations.");
      }
      const [{ projectScipFacts }, { runScipEvaluation }] = await Promise.all([
        import("../facts/scip.js"),
        import("../providers/index.js"),
      ]);
      const scanned = await scan(project, { full: true, kind: "evaluation-scip-setup" });
      sourceEngine = scanned.engine;
      const db = await getDb(project);
      dbOpened = true;
      workspaceDbPath = db.path;
      const sourceSignature = indexedSourceSignature(db);
      const evaluated = await timed(() =>
        runScipEvaluation(workspaceId(oracle.scenario, provider), project, db, artifacts),
      );
      const evaluation = evaluated.value;
      if (!evaluation.indexPath) {
        throw new Error("SCIP evaluation completed without a retained index artifact.");
      }
      if (!evaluation.scip) {
        throw new Error("SCIP evaluation completed without a decoded index summary.");
      }
      scipCounts = {
        documents: evaluation.scip.documents,
        definitions: evaluation.scip.definitions,
        references: evaluation.scip.references,
      };
      providerFailures.push(...scipConstraintFailures(scipCounts, scipExpected));
      const indexPath = evaluation.indexPath;
      batch = await projectScipFacts(evaluation, {
        workspaceId: evaluation.workspaceId,
        currentSourceSignature: sourceSignature,
      });
      providerArtifactBytes = await fileBytes(indexPath);
      if (scipCli) {
        // The production runner deletes staged sources after recording their
        // manifest. The official CLI resolves test files through the project
        // root embedded in the index and offers no override on `scip test`, so
        // recreate the same signed source generation only for validation and
        // remove it immediately afterward.
        const native = loadNative();
        if (!native?.stageSourceSnapshot) {
          throw new Error("Official SCIP validation requires the native snapshot runtime.");
        }
        const validationRoot = join(evaluation.artifactDir, "input");
        await native.stageSourceSnapshot(project, validationRoot, sourceSignature);
        try {
          official = await officialScipTest(
            scipCli,
            project,
            indexPath,
            scipExpected.commentSyntax,
            scipExpected.testFiles,
          );
        } finally {
          await rm(validationRoot, { recursive: true, force: true });
        }
      } else {
        official = await officialScipTest(
          null,
          project,
          indexPath,
          scipExpected.commentSyntax,
          scipExpected.testFiles,
        );
      }
      timings = {
        coldMs: evaluated.durationMs,
        warmMs: null,
        changedFileMs: null,
        scope: "SCIP TypeScript provider run, excluding syntax-index setup",
      };
    } else if (provider === "scip-python") {
      const scipExpected = oracle.scip?.[provider];
      if (!scipExpected) {
        throw new Error("SCIP-Python evaluation requires checked-in SCIP expectations.");
      }
      const { scipProjectionFacts } = await import("../facts/scip.js");
      const native = loadNative();
      if (!native?.inspectScip || !native.projectScip) {
        throw new Error("SCIP-Python evaluation requires the native SCIP projection runtime.");
      }
      const scanned = await scan(project, { full: true, kind: "evaluation-scip-python-setup" });
      sourceEngine = scanned.engine;
      const db = await getDb(project);
      dbOpened = true;
      workspaceDbPath = db.path;
      const sourceSignature = indexedSourceSignature(db);
      const indexPath = join(artifacts, "index.scip");
      const environmentPath = join(artifacts, "environment.json");
      await writeFile(environmentPath, "[]\n", { mode: 0o600 });
      const scipPython = bundledScipPython();
      // SCIP-Python compares source paths with a string prefix instead of
      // normalizing them. macOS exposes /var as a /private/var symlink, so a
      // non-canonical cwd causes a successful but empty index.
      const scipProject = await realpath(project);
      const providerStarted = performance.now();
      const command = await exec(
        process.execPath,
        [
          scipPython.cli,
          "index",
          "--cwd",
          scipProject,
          "--project-name",
          `sdlc-eval-${oracle.scenario}`,
          "--project-version",
          "HEAD",
          "--environment",
          environmentPath,
          "--output",
          indexPath,
          "--quiet",
        ],
        {
          cwd: scipProject,
          timeout: 5 * 60_000,
          maxBuffer: 2 * 1024 * 1024,
          maxFileSize: { path: indexPath, bytes: MAX_SCIP_INDEX_BYTES },
        },
      );
      if (
        command.spawnFailed ||
        command.timedOut ||
        command.truncated ||
        command.fileSizeExceeded ||
        command.exitCode !== 0
      ) {
        throw new Error(
          `SCIP-Python indexer failed: ${command.stderr || command.stdout || "no diagnostics"}`,
        );
      }
      const summary = await native.inspectScip(indexPath);
      scipCounts = {
        documents: summary.documents,
        definitions: summary.definitions,
        references: summary.references,
      };
      providerFailures.push(...scipConstraintFailures(scipCounts, scipExpected));
      const projection = await native.projectScip(indexPath, scipProject, []);
      const providerColdMs = Number((performance.now() - providerStarted).toFixed(3));
      batch = scipProjectionFacts(projection, {
        workspaceId: workspaceId(oracle.scenario, provider),
        producer: { id: "scip-python", version: scipPython.version, kind: "compiler" },
        generation: { sourceSignature },
        freshness: "unverified",
        ownership: { scope: "artifact", key: projection.sha256 },
        generatedAt: "1970-01-01T00:00:00.000Z",
      });
      providerArtifactBytes = await fileBytes(indexPath);
      official = await officialScipTest(
        scipCli,
        scipProject,
        indexPath,
        scipExpected.commentSyntax,
        scipExpected.testFiles,
      );
      timings = {
        coldMs: providerColdMs,
        warmMs: null,
        changedFileMs: null,
        scope: "SCIP-Python indexing, inspection, and projection, excluding syntax-index setup",
      };
    } else {
      const unsupported: never = provider;
      throw new Error(`Unsupported evaluation provider: ${unsupported}`);
    }

    const scores = scoreFactBatch(batch, oracle);
    const failures = [...thresholdFailures(provider, scores, oracle), ...providerFailures];
    let flow: ProviderEvaluationReport["flow"] = null;
    if (oracle.entryToEffect?.measuredProviders.includes(provider)) {
      const db = await getDb(project);
      dbOpened = true;
      const executionIndex = db.executionFlow();
      const candidates = executionIndex.entries.map((entry) =>
        executionFlowCandidate(db.executionFlow(entry.id)),
      );
      const candidate: CandidateFlowGraph = {
        entrypoints: candidates.flatMap((item) => item.entrypoints),
        relations: candidates.flatMap((item) => item.relations),
        paths: candidates.flatMap((item) => item.paths),
        diagnostics: [
          ...executionIndex.diagnostics,
          ...candidates.flatMap((item) => item.diagnostics),
          ...(executionIndex.entries.length === 0 && executionIndex.note
            ? [executionIndex.note]
            : []),
        ],
      };
      const flowScores = scoreFlowGraph(candidate, oracle.entryToEffect);
      failures.push(
        ...flowAcceptanceFailures(
          flowScores,
          oracle.entryToEffect.thresholds,
          candidate.diagnostics,
        ),
      );
      flow = {
        scores: flowScores,
        candidate: {
          entrypoints: candidate.entrypoints.length,
          relations: candidate.relations.length,
          paths: candidate.paths.length,
        },
        diagnostics: candidate.diagnostics,
      };
    }
    if (official?.status === "failed") {
      const detail = official.missingFiles.length
        ? `no assertions matched ${official.missingFiles.join(", ")}`
        : official.stderr || official.stdout || "no diagnostics";
      failures.push(
        `Official scip test failed (exit ${official.exitCode ?? "none"}): ${detail}`,
      );
    }

    if (dbOpened) {
      await closeDb(project);
      dbOpened = false;
    }
    if (!workspaceDbPath) throw new Error("Evaluation completed without a workspace store.");
    const workspaceDbBytes = await fileBytes(workspaceDbPath);
    return {
      provider,
      scenario: oracle.scenario,
      passed: failures.length === 0,
      failures,
      scores,
      timings,
      storage: { workspaceDbBytes, providerArtifactBytes },
      memory: {
        runnerPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        scope:
          provider.startsWith("scip-")
            ? "isolated SDLC runner; the external SCIP child peak is not yet sampled"
            : "isolated provider worker",
      },
      officialScipTest: official,
      scipCounts,
      flow,
      sourceEngine,
      unmeasured:
        provider.startsWith("scip-")
          ? [
              "warm and one-file-change provider indexing",
              "external SCIP child peak RSS",
              ...(flow ? [] : ["entry-to-effect path precision and recall"]),
              "retrieval quality",
            ]
          : [
              ...(flow ? [] : ["entry-to-effect path precision and recall"]),
              "retrieval quality",
            ],
    };
  } finally {
    // scan() can cache a connection before the branch reaches its explicit
    // getDb() bookkeeping. Always attempt eviction once setup created a root.
    if (cleanupProject) await closeDb(cleanupProject).catch(() => false);
    if (previousStateDir === undefined) delete process.env.SDLC_HOME;
    else process.env.SDLC_HOME = previousStateDir;
    const cleanup: Array<Promise<void>> = [
      ...(cleanupProject ? [rm(cleanupProject, { recursive: true, force: true })] : []),
      ...(cleanupArtifacts ? [rm(cleanupArtifacts, { recursive: true, force: true })] : []),
      rm(evaluationState, { recursive: true, force: true }),
    ];
    await Promise.all(cleanup);
  }
}

async function main(): Promise<void> {
  const provider = process.argv[2] as EvaluationProvider | undefined;
  const fixture = process.argv[3];
  const scipCli = process.argv[4] || null;
  if (!provider || !EVALUATION_PROVIDERS.includes(provider) || !fixture) {
    throw new Error("usage: worker <provider> <fixture> [scip-cli]");
  }
  process.stdout.write(`${JSON.stringify(await runEvaluationWorker(provider, fixture, scipCli))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

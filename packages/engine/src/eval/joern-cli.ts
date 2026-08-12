#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { exec, spawnEnv, which } from "../lib/exec.js";
import { flowAcceptanceFailures, scoreFlowGraph } from "./flow.js";
import { deriveLangGraphFlow, parseJoernGraphson } from "./joern-graphson.js";
import { loadEvaluationOracle } from "./model.js";

const DEFAULT_IMAGE =
  "ghcr.io/joernio/joern-slim@sha256:29eb685a95dc1db5a729043d8b5fc8f888f7c03ec6f1a8810736df62161f4b98";
const DEFAULT_FIXTURE = "python-langgraph-entry-effect";
const MAX_CPG_BYTES = 256 * 1024 * 1024;
const MAX_GRAPHSON_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLED_IMAGE_BYTES = 1_500_000_000;

interface CliOptions {
  fixture: string;
  image: string;
  docker: string;
}

interface JoernEvaluationRun {
  report: Record<string, unknown>;
  passed: boolean;
}

const imageInspectSchema = z.object({
  Id: z.string().min(1),
  Created: z.string().min(1),
  Architecture: z.string().min(1),
  Os: z.string().min(1),
  Size: z.number().int().nonnegative(),
  Config: z.object({ Labels: z.record(z.string()).nullable().optional() }),
});

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fixture: DEFAULT_FIXTURE,
    image: process.env.JOERN_IMAGE ?? DEFAULT_IMAGE,
    docker: process.env.DOCKER_CLI ?? "docker",
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (["--fixture", "--image", "--docker"].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === "--fixture") options.fixture = value;
      else if (argument === "--image") options.image = value;
      else options.docker = value;
    } else if (argument !== "--json") {
      throw new Error(`Unknown Joern evaluation option: ${argument}`);
    }
  }
  if (!options.image.includes("@sha256:")) {
    throw new Error("The Joern evaluation image must use an immutable sha256 digest.");
  }
  return options;
}

async function fixtureRoot(selected: string): Promise<string> {
  if (isAbsolute(selected)) return realpath(selected);
  const root = fileURLToPath(new URL("../../fixtures/eval/", import.meta.url));
  const selectedPath = resolve(root, selected);
  const child = relative(root, selectedPath);
  if (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("A relative Joern fixture must stay inside the checked-in evaluation corpus.");
  }
  return realpath(selectedPath);
}

function checkResult(
  label: string,
  result: Awaited<ReturnType<typeof exec>>,
): void {
  if (
    result.spawnFailed ||
    result.timedOut ||
    result.truncated ||
    result.fileSizeExceeded ||
    result.exitCode !== 0
  ) {
    const reason = result.fileSizeExceeded
      ? "artifact exceeded its configured bound"
      : result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode ?? "none"}`;
    throw new Error(`${label} failed: ${reason}`);
  }
}

function bindMount(source: string, target: string, readonly = false): string {
  if (source.includes(",")) throw new Error(`Docker evaluation mount path contains a comma: ${source}`);
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

function dockerRunPrefix(
  image: string,
  imagePlatform: string,
  project: string,
  artifacts: string,
  containerName: string,
): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--platform",
    imagePlatform,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=512m",
    "--memory",
    "4g",
    "--cpus",
    "4",
    "--pids-limit",
    "512",
    ...(uid !== undefined && gid !== undefined ? ["--user", `${uid}:${gid}`] : []),
    "-e",
    "HOME=/tmp",
    "--mount",
    bindMount(project, "/input", true),
    "--mount",
    bindMount(artifacts, "/output"),
    image,
  ];
}

function containerAbsent(result: Awaited<ReturnType<typeof exec>>): boolean {
  const message = `${result.stdout}\n${result.stderr}`;
  return /No such (?:container|object)/i.test(message);
}

async function removeContainer(docker: string, containerName: string): Promise<void> {
  const removed = await exec(docker, ["rm", "--force", "--volumes", containerName], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (removed.exitCode === 0 || containerAbsent(removed)) return;
  checkResult(`Joern container cleanup (${containerName})`, removed);
}

async function runContainer(
  docker: string,
  args: string[],
  containerName: string,
  options: Parameters<typeof exec>[2],
): Promise<Awaited<ReturnType<typeof exec>>> {
  try {
    return await exec(docker, args, options);
  } finally {
    // Killing an attached Docker CLI does not stop the server-side container.
    // The unique name lets every timeout, artifact limit, abort, and normal
    // completion explicitly remove the exact container this evaluator owns.
    await removeContainer(docker, containerName);
  }
}

async function run(): Promise<JoernEvaluationRun> {
  const options = parseArgs(process.argv.slice(2));
  const docker = await which(options.docker, spawnEnv());
  if (!docker) throw new Error(`Docker CLI was not found: ${options.docker}`);

  const inspected = await exec(
    docker,
    ["image", "inspect", options.image, "--format", "{{json .}}"],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (inspected.exitCode !== 0 || inspected.spawnFailed || inspected.timedOut || inspected.truncated) {
    throw new Error(
      `The pinned Joern image is not available locally. Pull it explicitly first:\n` +
        `docker pull ${options.image}`,
    );
  }
  const image = imageInspectSchema.parse(JSON.parse(inspected.stdout));
  const labels = image.Config.Labels ?? {};
  const joernVersion = labels["org.opencontainers.image.revision"] ?? image.Id;
  const imagePlatform = `${image.Os}/${image.Architecture}`;

  const sourceFixture = await fixtureRoot(options.fixture);
  const oracle = await loadEvaluationOracle(join(sourceFixture, "oracle.json"));
  if (!oracle.entryToEffect) throw new Error(`Scenario ${oracle.scenario} has no entry-to-effect oracle.`);
  if (!oracle.languages.includes("python")) {
    throw new Error("The first Joern flow adapter is intentionally limited to the Python/LangGraph fixture.");
  }

  const project = await mkdtemp(join(tmpdir(), "sdlc-joern-input-"));
  const artifacts = await mkdtemp(join(tmpdir(), "sdlc-joern-output-"));
  try {
    await cp(sourceFixture, project, { recursive: true });
    const canonicalProject = await realpath(project);
    const canonicalArtifacts = await realpath(artifacts);
    const cpgPath = join(canonicalArtifacts, "cpg.bin");
    const graphsonPath = join(canonicalArtifacts, "graphson", "export.json");

    const parseContainer = `sdlc-joern-parse-${randomUUID()}`;
    const parseStarted = performance.now();
    const parsed = await runContainer(
      docker,
      [
        ...dockerRunPrefix(
          options.image,
          imagePlatform,
          canonicalProject,
          canonicalArtifacts,
          parseContainer,
        ),
        "joern-parse",
        "/input",
        "--language",
        "PYTHONSRC",
        "--output",
        "/output/cpg.bin",
      ],
      parseContainer,
      {
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
        maxFileSize: { path: cpgPath, bytes: MAX_CPG_BYTES },
      },
    );
    const parseMs = Number((performance.now() - parseStarted).toFixed(3));
    checkResult("Joern parse", parsed);

    const exportContainer = `sdlc-joern-export-${randomUUID()}`;
    const exportStarted = performance.now();
    const exported = await runContainer(
      docker,
      [
        ...dockerRunPrefix(
          options.image,
          imagePlatform,
          canonicalProject,
          canonicalArtifacts,
          exportContainer,
        ),
        "joern-export",
        "/output/cpg.bin",
        "--out",
        "/output/graphson",
        "--repr",
        "all",
        "--format",
        "graphson",
      ],
      exportContainer,
      {
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
        maxFileSize: { path: graphsonPath, bytes: MAX_GRAPHSON_BYTES },
      },
    );
    const exportMs = Number((performance.now() - exportStarted).toFixed(3));
    checkResult("Joern GraphSON export", exported);

    const [cpgStat, graphsonStat, graphsonContents, manifestContents] = await Promise.all([
      stat(cpgPath),
      stat(graphsonPath),
      readFile(graphsonPath, "utf-8"),
      readFile(join(canonicalProject, "langgraph.json"), "utf-8"),
    ]);
    if (cpgStat.size > MAX_CPG_BYTES) throw new Error("Joern CPG exceeds the post-run size bound.");
    if (graphsonStat.size > MAX_GRAPHSON_BYTES) throw new Error("Joern GraphSON exceeds the post-run size bound.");

    const adaptStarted = performance.now();
    const graph = parseJoernGraphson(graphsonContents);
    const candidate = deriveLangGraphFlow(graph, manifestContents, joernVersion);
    const scores = scoreFlowGraph(candidate, oracle.entryToEffect);
    const adaptMs = Number((performance.now() - adaptStarted).toFixed(3));

    const flowFailures = flowAcceptanceFailures(
      scores,
      oracle.entryToEffect.thresholds,
      candidate.diagnostics,
    );
    const flowCriteriaPassed = flowFailures.length === 0;
    const relationEvidencePassed = scores.metadataMismatches.every(
      (mismatch) =>
        mismatch.expectedEvidence.path === mismatch.actualEvidence.path &&
        mismatch.expectedEvidence.startLine === mismatch.actualEvidence.startLine,
    ) && scores.missingRelationEvidence.length === 0;
    const nativeImage =
      (process.arch === "arm64" && image.Architecture === "arm64") ||
      (process.arch === "x64" && image.Architecture === "amd64");
    const packagingCriteria = {
      maximumExtractedImageBytes: MAX_BUNDLED_IMAGE_BYTES,
      actualExtractedImageBytes: image.Size,
      imageSizePassed: image.Size <= MAX_BUNDLED_IMAGE_BYTES,
      nativeHostArchitecturePassed: nativeImage,
      boundedNormalizedExportPassed: false,
    };
    const packagingCriteriaPassed =
      packagingCriteria.imageSizePassed &&
      packagingCriteria.nativeHostArchitecturePassed &&
      packagingCriteria.boundedNormalizedExportPassed;

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scenario: oracle.scenario,
      passed: flowCriteriaPassed,
      provider: {
        id: "joern-cpg-langgraph-evaluation",
        bundled: false,
        image: options.image,
        imageId: image.Id,
        imageCreatedAt: image.Created,
        sourceRevision: labels["org.opencontainers.image.revision"] ?? null,
        license: labels["org.opencontainers.image.licenses"] ?? null,
        platform: imagePlatform,
        emulated: !nativeImage,
      },
      isolation: {
        network: "none",
        capabilities: "all-dropped",
        noNewPrivileges: true,
        rootFilesystem: "read-only",
        sourceMount: "read-only app-owned fixture copy",
        memoryBytes: 4 * 1024 * 1024 * 1024,
        cpus: 4,
        pids: 512,
      },
      artifacts: {
        cpgBytes: cpgStat.size,
        graphsonBytes: graphsonStat.size,
        vertices: graph.vertexCount,
        edges: graph.edgeCount,
        extractedImageBytes: image.Size,
      },
      timings: {
        parseMs,
        exportMs,
        adaptAndScoreMs: adaptMs,
        totalProviderMs: Number((parseMs + exportMs).toFixed(3)),
      },
      candidate: {
        entrypoints: candidate.entrypoints.length,
        relations: candidate.relations.length,
        paths: candidate.paths.length,
        relationProducers: Object.fromEntries(
          [...new Set(candidate.relations.map((relation) => `${relation.producer.kind}:${relation.producer.id}:${relation.certainty}`))]
            .sort()
            .map((producer) => [
              producer,
              candidate.relations.filter(
                (relation) =>
                  `${relation.producer.kind}:${relation.producer.id}:${relation.certainty}` === producer,
              ).length,
            ]),
        ),
        diagnostics: candidate.diagnostics,
      },
      scores,
      criteria: {
        thresholds: oracle.entryToEffect.thresholds,
        actual: {
          entrypointPrecision: scores.entrypoints.precision,
          entrypointRecall: scores.entrypoints.recall,
          relationPrecision: scores.relations.precision,
          relationRecall: scores.relations.recall,
          exactRelationSequencePathPrecision: scores.paths.precision,
          exactRelationSequencePathRecall: scores.paths.recall,
        },
        entrypointEvidencePassed: scores.entrypointMetadataMismatches.length === 0,
        relationEvidencePassed,
        adapterDiagnosticsPassed: candidate.diagnostics.length === 0,
        failures: flowFailures,
        flowCriteriaPassed,
        packaging: { ...packagingCriteria, packagingCriteriaPassed },
      },
      decision: {
        promoteBundledProvider: flowCriteriaPassed && packagingCriteriaPassed,
        recommendedStatus: "evaluation-only",
        rationale: [
          flowCriteriaPassed
            ? "Joern plus the narrow LangGraph adapter clears the predeclared flow-coverage floor."
            : "Joern plus the narrow LangGraph adapter does not clear the flow-coverage floor.",
          "The asserted result-store effect remains human knowledge and is not promoted to a deterministic provider fact.",
          "This evaluation path uses a size-bounded full GraphSON export; a provider-side normalized export was not demonstrated.",
          "Image size, architecture coverage, and full-graph translation must improve before desktop bundling.",
        ],
      },
      explicitlyUnmeasured: [
        ...scores.explicitlyUnmeasured,
        "external provider peak RSS",
        "warm and one-file-change indexing",
        "compressed registry transfer size in this command",
      ],
    };
    return { report, passed: flowCriteriaPassed };
  } finally {
    await Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(artifacts, { recursive: true, force: true }),
    ]);
  }
}

void run()
  .then(({ report, passed }) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

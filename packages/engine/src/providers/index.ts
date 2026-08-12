/**
 * External code-intelligence providers.
 *
 * The TypeScript here is a thin Node/package boundary: it locates the bundled
 * JavaScript indexer and uses the daemon's existing cross-platform process
 * supervisor. SCIP decoding, bounds, and aggregate extraction live in Rust.
 */

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { providersDir } from "@sdlc/protocol";
import { findTsConfigs } from "../analyze/tools.js";
import type { Db } from "../db/db.js";
import { exec, spawnEnv, which } from "../lib/exec.js";
import { resolveWorkspacePath } from "../lib/workspace-path.js";
import {
  loadNative,
  type NativeScipPathAlias,
  type NativeScipSummary,
  type NativeSnapshotManifest,
} from "../scan/source.js";
import { indexedSourceSignature } from "../scan/signature.js";

export type ProviderTrust = "syntax" | "unverified" | "exact" | "stale";

export interface ProviderStatus {
  id: "tree-sitter" | "scip-typescript" | "joern";
  name: string;
  available: boolean;
  bundled: boolean;
  version: string | null;
  capabilities: string[];
  trust: ProviderTrust;
  detail: string;
}

export interface ScipBaseline {
  documents: number;
  symbols: number;
  references: number;
}

export interface ScipEvaluation {
  /** Stable app workspace that owns this run and every fact projected from it. */
  workspaceId: string;
  runId: string;
  provider: "scip-typescript";
  providerVersion: string;
  status: "ok" | "partial" | "failed";
  trust: "unverified" | "exact" | "stale";
  exact: boolean;
  reason:
    | "mutable_working_tree"
    | "immutable_staged_snapshot"
    | "working_tree_changed"
    | "provider_failed"
    | "staged_input_changed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  artifactDir: string;
  indexPath: string | null;
  /** Repository-relative project roots, or the app-owned inferred-input marker. */
  projects: string[];
  baseline: ScipBaseline;
  input: {
    sourceSignature: string;
    inputSignature: string;
    files: number;
    bytes: number;
    /** Durable manifests include entries; daemon responses deliberately omit them. */
    entries?: NativeSnapshotManifest["entries"];
    /** Case aliases observed and canonicalized before the staged input was removed. */
    pathAliases?: NativeScipPathAlias[];
    /** Digest binding the ordered alias pairs to the provider run. */
    pathAliasSignature?: string;
  } | null;
  scip: NativeScipSummary | null;
  error: string | null;
}

interface ScipPackage {
  version: string;
  bin: string | Record<string, string>;
}

const require = createRequire(import.meta.url);
const DETECTION_TTL_MS = 5 * 60_000;
const SCIP_TIMEOUT_MS = 15 * 60_000;
const SCIP_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_OUTPUT = 4 * 1024 * 1024;
const MAX_SCIP_INDEX_BYTES = 128 * 1024 * 1024;
const RETAINED_SCIP_RUNS = 5;
const UNATTESTED_INPUT_CLOSURE =
  "The repository source snapshot is attested, but dependency and out-of-tree compiler inputs are not yet fenced; SCIP coverage is evaluation-only.";
let detectionCache: { expiresAt: number; providers: ProviderStatus[] } | null = null;
interface ActiveScipRun {
  controller: AbortController;
  promise: Promise<ScipEvaluation>;
}
const activeScipRuns = new Map<string, ActiveScipRun>();

function bundledScip(): { cli: string; version: string } | null {
  try {
    const packagePath = require.resolve("@sourcegraph/scip-typescript/package.json");
    const pkg = require(packagePath) as ScipPackage;
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["scip-typescript"];
    if (!bin) return null;
    return { cli: join(dirname(packagePath), bin), version: pkg.version };
  } catch {
    return null;
  }
}

export async function detectProviders(refresh = false): Promise<ProviderStatus[]> {
  if (!refresh && detectionCache && detectionCache.expiresAt > Date.now()) {
    return detectionCache.providers;
  }

  const scip = bundledScip();
  const native = loadNative();
  const scipRuntime = Boolean(
    native?.inspectScip && native.stageSourceSnapshot && native.snapshotManifest,
  );
  const joern = await which("joern-parse", spawnEnv());
  const providers: ProviderStatus[] = [
    {
      id: "tree-sitter",
      name: "Tree-sitter syntax index",
      available: true,
      bundled: true,
      version: null,
      capabilities: ["files", "symbols", "imports", "structural-search"],
      trust: "syntax",
      detail: native ? "Bundled Rust scanner active." : "Bundled WASM fallback active.",
    },
    {
      id: "scip-typescript",
      name: "SCIP TypeScript",
      available: Boolean(scip && scipRuntime),
      bundled: Boolean(scip),
      version: scip?.version ?? null,
      capabilities: [
        "definitions",
        "references",
        "implementations",
        "symbol-identity",
        ...(native?.projectScip && native.verifySnapshotManifest ? ["fact-projection"] : []),
      ],
      trust: "unverified",
      detail: !scip
        ? "Bundled indexer is missing."
        : !scipRuntime
          ? "Native SCIP snapshot/import support is unavailable; syntax indexing still works."
          : "Ready to evaluate against an app-owned, attested source snapshot.",
    },
    {
      id: "joern",
      name: "Joern Code Property Graph",
      available: Boolean(joern),
      bundled: false,
      version: null,
      capabilities: ["ast", "control-flow", "data-flow", "call-graph"],
      trust: "unverified",
      detail: joern
        ? `Detected at ${joern}; production use remains disabled after the bounded evaluation.`
        : "Optional heavyweight provider. An opt-in digest-pinned Docker evaluation command exists; production use is disabled.",
    },
  ];
  detectionCache = { expiresAt: Date.now() + DETECTION_TTL_MS, providers };
  return providers;
}

function baseline(db: Db): ScipBaseline {
  return {
    documents: db.count(
      "SELECT COUNT(*) AS n FROM files WHERE present = 1 AND lang IN ('typescript','javascript')",
    ),
    symbols: db.count(
      `SELECT COUNT(*) AS n FROM symbols
       WHERE path IN (SELECT path FROM files WHERE present = 1 AND lang IN ('typescript','javascript'))`,
    ),
    references: db.count(
      `SELECT COUNT(*) AS n FROM refs
       WHERE src_path IN (SELECT path FROM files WHERE present = 1 AND lang IN ('typescript','javascript'))`,
    ),
  };
}

function runId(): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(4).toString("hex")}`;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function writeManifest(path: string, evaluation: ScipEvaluation): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(evaluation, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

async function pruneOldRuns(root: string): Promise<void> {
  const runs = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(
    runs.slice(RETAINED_SCIP_RUNS).map((run) => rm(join(root, run), { recursive: true, force: true })),
  );
}

interface ScipProjects {
  /** Actual project arguments passed to scip-typescript. */
  args: string[];
  /** Stable, non-sensitive descriptions recorded in the run manifest. */
  recorded: string[];
  error: string | null;
  incomplete: string | null;
}

/**
 * Select explicit configs without ever asking the upstream CLI to create one
 * in the user's repository.
 *
 * scip-typescript's --infer-tsconfig writes <workspace>/tsconfig.json. For a
 * configless JavaScript/TypeScript project, give it an app-owned config whose
 * exact file list comes from the deterministic index instead. This function
 * runs only after `root` has become the private staged input view.
 */
async function scipProjects(
  root: string,
  db: Db,
  artifactDir: string,
  signal: AbortSignal,
): Promise<ScipProjects> {
  signal.throwIfAborted();
  const discovery = await findTsConfigs(
    root,
    64,
    signal,
    ["tsconfig.json", "jsconfig.json"],
    false,
  );
  if (discovery.capped) {
    return {
      args: [],
      recorded: [],
      error: `TypeScript project discovery exceeded the ${discovery.roots.length}-project safety cap.`,
      incomplete: null,
    };
  }
  const record = (config: string): string => {
    const path = toPosix(relative(root, config));
    if (path.endsWith("/tsconfig.json") || path === "tsconfig.json") {
      return toPosix(dirname(path)) === "." ? "." : toPosix(dirname(path));
    }
    return path;
  };
  const issueText = discovery.issues
    .map((issue) => `${toPosix(relative(root, issue.config))}: ${issue.message}`)
    .join("\n");
  const recorded = [...discovery.configs.map(record), ...discovery.issues.map((issue) => record(issue.config))]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  if (discovery.configs.length > 0) {
    return {
      args: discovery.configs.map((config) => toPosix(relative(root, config))),
      recorded,
      error: null,
      incomplete: issueText
        ? `SCIP skipped or could not fully index at least one project:\n${issueText}`
        : null,
    };
  }
  if (discovery.found > 0) {
    return {
      args: [],
      recorded,
      error:
        `No discovered TypeScript or JavaScript project config could be indexed.` +
        (issueText ? `\n${issueText}` : ""),
      incomplete: null,
    };
  }

  const files = db
    .all<{ path: string }>(
      "SELECT path FROM files WHERE present = 1 AND lang IN ('typescript','javascript') ORDER BY path",
    )
    .map((row) => resolveWorkspacePath(root, row.path));
  signal.throwIfAborted();
  if (files.length === 0) {
    return {
      args: [],
      recorded: [],
      error: "No TypeScript or JavaScript source files are available for SCIP evaluation.",
      incomplete: null,
    };
  }

  const configPath = join(artifactDir, ".sdlc-provider", "inferred-tsconfig.json");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          allowJs: true,
          allowSyntheticDefaultImports: true,
          checkJs: false,
          noEmit: true,
          skipLibCheck: true,
        },
        files: files.map((path) => toPosix(relative(dirname(configPath), path))),
      },
      null,
      2,
    ),
    { mode: 0o600, signal },
  );
  return {
    args: [configPath],
    recorded: ["(app-owned inferred config)"],
    error: null,
    incomplete: null,
  };
}

function incompleteDiagnostic(stdout: string, stderr: string): string | null {
  const diagnostics = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^error TS\d+:/i.test(line) ||
        /unexpected error indexing project root/i.test(line) ||
        /missing tsconfig\.json/i.test(line) ||
        /info: skipping file/i.test(line),
    );
  if (diagnostics.length === 0) return null;
  return `SCIP skipped or could not fully index at least one project:\n${diagnostics.join("\n").slice(0, 4_000)}`;
}

function withCurrentSourceState(
  evaluation: ScipEvaluation,
  currentSourceSignature?: string,
): ScipEvaluation {
  if (
    !currentSourceSignature ||
    !evaluation.input ||
    evaluation.status === "failed" ||
    !evaluation.scip ||
    evaluation.input.sourceSignature === currentSourceSignature
  ) {
    return evaluation;
  }
  return {
    ...evaluation,
    trust: "stale",
    exact: false,
    reason: "working_tree_changed",
  };
}

/** Keep the durable evidence on disk without sending it in the polled API. */
function withoutInputEntries(evaluation: ScipEvaluation): ScipEvaluation {
  if (!evaluation.input?.entries) return evaluation;
  return {
    ...evaluation,
    input: {
      sourceSignature: evaluation.input.sourceSignature,
      inputSignature: evaluation.input.inputSignature,
      files: evaluation.input.files,
      bytes: evaluation.input.bytes,
      ...(evaluation.input.pathAliasSignature
        ? { pathAliasSignature: evaluation.input.pathAliasSignature }
        : {}),
    },
  };
}

/** Stop waiting for native work even when the underlying worker cannot be preempted. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("The operation was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Race a non-preemptible napi task with cancellation without deleting files it
 * may still be reading or writing. The unique run directory is reclaimed as
 * soon as the native task actually settles.
 */
async function abortableArtifactWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
  artifactDir: string,
): Promise<T> {
  try {
    return await abortable(work, signal);
  } catch (cause) {
    if (!signal.aborted) throw cause;
    void work
      .then(
        () => rm(artifactDir, { recursive: true, force: true }),
        () => rm(artifactDir, { recursive: true, force: true }),
      )
      .catch(() => {});
    throw signal.reason ?? cause;
  }
}

async function evaluateScip(
  workspaceId: string,
  root: string,
  db: Db,
  artifactsRoot: string,
  signal: AbortSignal,
): Promise<ScipEvaluation> {
  signal.throwIfAborted();
  const scip = bundledScip();
  const native = loadNative();
  if (!scip) throw new Error("The bundled SCIP TypeScript indexer is unavailable.");
  if (!native?.inspectScip || !native.stageSourceSnapshot || !native.snapshotManifest) {
    throw new Error("The native SCIP snapshot/import runtime is unavailable.");
  }

  const id = runId();
  const artifactDir = join(artifactsRoot, workspaceId, "scip-typescript", id);
  const snapshotRoot = join(artifactDir, "input");
  const indexPath = join(artifactDir, "index.scip");
  const manifestPath = join(artifactDir, "manifest.json");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const base = baseline(db);
  const expectedSourceSignature = indexedSourceSignature(db);

  // The provider never reads the mutable workspace. Rust walks the same
  // deterministic source boundary as the indexer, refuses a generation that
  // no longer matches the DB, and writes a private app-owned input view.
  if (signal.aborted) {
    await rm(artifactDir, { recursive: true, force: true });
    throw signal.reason ?? new Error("SCIP evaluation cancelled.");
  }
  let staged;
  try {
    const staging = native.stageSourceSnapshot(root, snapshotRoot, expectedSourceSignature);
    staged = await abortableArtifactWork(staging, signal, artifactDir);
  } catch (cause) {
    if (signal.aborted) {
      throw signal.reason ?? cause;
    }
    await rm(artifactDir, { recursive: true, force: true });
    throw cause;
  }
  if (signal.aborted) {
    await rm(artifactDir, { recursive: true, force: true });
    throw signal.reason ?? new Error("SCIP evaluation cancelled.");
  }
  if (indexedSourceSignature(db) !== staged.sourceSignature) {
    await rm(artifactDir, { recursive: true, force: true });
    throw new Error("The source index changed while SCIP inputs were staged. Run the evaluation again.");
  }
  // macOS exposes /var through the /private/var symlink. Passing the lexical
  // staging path as --cwd while TypeScript canonicalizes source files through
  // realpath makes SCIP emit ../../-escaped document paths. Bind every provider
  // operation to the canonical staged root so upstream `scip test` and SDLC's
  // projection agree on portable repository-relative document paths.
  const providerRoot = await realpath(snapshotRoot);

  // scip-typescript treats a positional cwd as one project. That fails for
  // ordinary npm monorepos whose configs live under packages/ and apps/, so
  // reuse the repository's bounded project discovery and pass every real
  // config owner explicitly. Configless projects receive an app-owned config;
  // the upstream --infer-tsconfig flag is intentionally never used because it
  // writes into the source workspace.
  let selectedProjects: ScipProjects;
  const discoverySignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(SCIP_DISCOVERY_TIMEOUT_MS),
  ]);
  try {
    selectedProjects = await scipProjects(providerRoot, db, providerRoot, discoverySignal);
  } catch (cause) {
    if (signal.aborted) {
      await rm(artifactDir, { recursive: true, force: true });
      throw signal.reason ?? cause;
    }
    if (discoverySignal.aborted) {
      selectedProjects = {
        args: [],
        recorded: [],
        error: "SCIP project discovery exceeded the 30 second safety limit.",
        incomplete: null,
      };
    } else {
      await rm(artifactDir, { recursive: true, force: true });
      throw cause;
    }
  }
  const projects = selectedProjects.recorded;
  let inputManifest: NativeSnapshotManifest;
  try {
    const manifestingInput = native.snapshotManifest(providerRoot);
    inputManifest = await abortableArtifactWork(manifestingInput, signal, artifactDir);
  } catch (cause) {
    if (signal.aborted) throw signal.reason ?? cause;
    await rm(artifactDir, { recursive: true, force: true });
    throw cause;
  }

  let summary: NativeScipSummary | null = null;
  let pathAliases: NativeScipPathAlias[] = [];
  let pathAliasSignature: string | undefined;
  let error: string | null = selectedProjects.error;
  let incomplete: string | null = [selectedProjects.incomplete, UNATTESTED_INPUT_CLOSURE]
    .filter(Boolean)
    .join("\n");
  let reason: ScipEvaluation["reason"] = "provider_failed";
  if (!error) {
    let command;
    try {
      command = await exec(
        process.execPath,
        [
          scip.cli,
          "index",
          // Commander parses these positionals before the options below. Make
          // every relative repository path unambiguously data so a legal
          // directory such as `--infer-tsconfig/` cannot become a flag.
          ...selectedProjects.args.map((project) =>
            project.startsWith("-") ? `./${project}` : project,
          ),
          "--cwd",
          providerRoot,
          "--output",
          indexPath,
          "--no-progress-bar",
          "--no-global-caches",
        ],
        {
          cwd: providerRoot,
          timeout: SCIP_TIMEOUT_MS,
          maxBuffer: MAX_PROVIDER_OUTPUT,
          maxFileSize: { path: indexPath, bytes: MAX_SCIP_INDEX_BYTES },
          env: { ...spawnEnv(), NO_COLOR: "1" },
          signal,
        },
      );
    } catch (cause) {
      // Cancellation must not leave an unmanifested partial index behind.
      await rm(artifactDir, { recursive: true, force: true });
      throw cause;
    }

    if (command.spawnFailed) error = "Could not start the bundled SCIP indexer.";
    else if (command.timedOut) error = "SCIP indexing exceeded the 15 minute evaluation limit.";
    else if (command.truncated) error = "SCIP indexing produced too much diagnostic output.";
    else if (command.fileSizeExceeded) {
      error = "SCIP index exceeded the 128 MiB evaluation artifact limit.";
    } else if (command.exitCode !== 0) {
      // The upstream CLI writes some errors to stdout and progress to stderr.
      error =
        [command.stderr, command.stdout]
          .map((part) => part.trim())
          .filter(Boolean)
          .join("\n")
          .slice(0, 4_000) || `SCIP indexer exited ${command.exitCode}.`;
    } else {
      const reported = incompleteDiagnostic(command.stdout, command.stderr);
      incomplete = [incomplete, reported].filter(Boolean).join("\n") || null;
      let after: NativeSnapshotManifest;
      try {
        const manifestingOutput = native.snapshotManifest(providerRoot);
        after = await abortableArtifactWork(manifestingOutput, signal, artifactDir);
        if (after.inputSignature !== inputManifest.inputSignature) {
          error = "SCIP changed its staged input view; the output was discarded.";
          reason = "staged_input_changed";
        } else {
          const inspecting = native.inspectScip(indexPath);
          const inspected = await abortableArtifactWork(inspecting, signal, artifactDir);
          if (native.projectScip) {
            try {
              const projecting = native.projectScip(indexPath, providerRoot, []);
              const projection = await abortableArtifactWork(projecting, signal, artifactDir);
              const inputs = new Set(inputManifest.entries.map((entry) => entry.path));
              const unattested = projection.documents.find(
                (document) => !inputs.has(document.path),
              );
              if (unattested) {
                throw new Error(
                  `SCIP document was not present in the staged input manifest: ${unattested.path}`,
                );
              }
              pathAliases = projection.pathAliases;
              pathAliasSignature = projection.pathAliasSignature;
            } catch (cause) {
              if (signal.aborted) throw signal.reason ?? cause;
              const detail = cause instanceof Error ? cause.message : String(cause);
              incomplete = [incomplete, `SCIP fact projection is unavailable: ${detail}`]
                .filter(Boolean)
                .join("\n");
            }
          }
          summary = inspected;
          reason = "immutable_staged_snapshot";
        }
      } catch (cause) {
        if (signal.aborted) {
          throw signal.reason ?? cause;
        }
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
  }

  if (signal.aborted) {
    await rm(artifactDir, { recursive: true, force: true });
    throw signal.reason ?? new Error("SCIP evaluation cancelled.");
  }

  // The manifest is the durable evidence; retaining a complete source copy in
  // each of the five evaluation runs would multiply private data and disk use.
  await rm(snapshotRoot, { recursive: true, force: true });

  const exact = summary !== null && error === null && incomplete === null;

  const evaluation: ScipEvaluation = {
    workspaceId,
    runId: id,
    provider: "scip-typescript",
    providerVersion: scip.version,
    status: error ? "failed" : incomplete ? "partial" : "ok",
    trust: exact ? "exact" : "unverified",
    exact,
    reason,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    artifactDir,
    indexPath: summary ? indexPath : null,
    projects,
    baseline: base,
    input: {
      sourceSignature: staged.sourceSignature,
      inputSignature: inputManifest.inputSignature,
      files: inputManifest.files,
      bytes: inputManifest.bytes,
      entries: inputManifest.entries,
      pathAliases,
      ...(pathAliasSignature ? { pathAliasSignature } : {}),
    },
    scip: summary,
    error: error ?? incomplete,
  };
  if (error) await rm(indexPath, { force: true });
  await writeManifest(manifestPath, evaluation);
  // Provider artifacts are app-owned diagnostics, not an unbounded history.
  // A pruning failure must not discard an otherwise valid evaluation.
  await pruneOldRuns(join(artifactsRoot, workspaceId, "scip-typescript")).catch(() => {});
  return withoutInputEntries(withCurrentSourceState(evaluation, indexedSourceSignature(db)));
}

/** One SCIP process per workspace. Repeated callers share the same run. */
export function runScipEvaluation(
  workspaceId: string,
  root: string,
  db: Db,
  artifactsRoot = providersDir(),
): Promise<ScipEvaluation> {
  const existing = activeScipRuns.get(workspaceId);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const running = evaluateScip(workspaceId, root, db, artifactsRoot, controller.signal).finally(() => {
    activeScipRuns.delete(workspaceId);
  });
  activeScipRuns.set(workspaceId, { controller, promise: running });
  return running;
}

export function scipEvaluationRunning(workspaceId: string): boolean {
  return activeScipRuns.has(workspaceId);
}

/** Stop one provider before workspace eviction and wait for it to release the DB. */
export async function cancelScipEvaluation(workspaceId: string): Promise<void> {
  const active = activeScipRuns.get(workspaceId);
  if (!active) return;
  active.controller.abort(new Error("SCIP evaluation cancelled."));
  await Promise.allSettled([active.promise]);
}

/** Shutdown is synchronous at the HTTP boundary; aborting the child is immediate. */
export function cancelAllScipEvaluations(): void {
  for (const active of activeScipRuns.values()) {
    active.controller.abort(new Error("SDLC is shutting down."));
  }
}

export interface LatestScipEvaluationOptions {
  artifactsRoot?: string;
  currentSourceSignature?: string;
}

export async function latestScipEvaluation(
  workspaceId: string,
  options: LatestScipEvaluationOptions = {},
): Promise<ScipEvaluation | null> {
  const root = join(options.artifactsRoot ?? providersDir(), workspaceId, "scip-typescript");
  try {
    const runs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const run of runs) {
      try {
        const evaluation = JSON.parse(
          await readFile(join(root, run, "manifest.json"), "utf-8"),
        ) as ScipEvaluation;
        if (evaluation.workspaceId !== workspaceId) continue;
        return withoutInputEntries(
          withCurrentSourceState(evaluation, options.currentSourceSignature),
        );
      } catch {
        // Ignore an interrupted or corrupt run and try the preceding manifest.
      }
    }
  } catch {
    // No provider directory yet.
  }
  return null;
}

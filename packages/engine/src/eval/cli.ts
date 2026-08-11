#!/usr/bin/env node

import { access, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, which } from "../lib/exec.js";
import {
  loadEvaluationOracle,
  type EvaluationOracle,
  type EvaluationProvider,
} from "./model.js";
import type { ProviderEvaluationReport } from "./worker.js";

interface CliOptions {
  fixture: string | null;
  scipCli: string | null;
  requireScipCli: boolean;
}

interface ScipCliStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  required: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fixture: null,
    scipCli: process.env.SCIP_CLI ?? null,
    requireScipCli: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--require-scip-cli") {
      options.requireScipCli = true;
    } else if (arg === "--fixture" || arg === "--scip-cli") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === "--fixture") options.fixture = value;
      else options.scipCli = value;
    } else if (arg !== "--json") {
      throw new Error(`Unknown evaluation option: ${arg}`);
    }
  }
  return options;
}

async function executable(candidate: string | null): Promise<string | null> {
  if (!candidate) return which("scip");
  if (!candidate.includes("/") && !candidate.includes("\\") && !isAbsolute(candidate)) {
    return which(candidate);
  }
  const path = resolve(candidate);
  try {
    await access(path);
    return path;
  } catch {
    return null;
  }
}

async function scipCliStatus(options: CliOptions): Promise<ScipCliStatus> {
  const path = await executable(options.scipCli);
  if (!path) {
    return { available: false, path: null, version: null, required: options.requireScipCli };
  }
  const version = await exec(path, ["--version"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  return {
    available: version.exitCode === 0,
    path,
    version: version.exitCode === 0 ? (version.stdout || version.stderr).trim() : null,
    required: options.requireScipCli,
  };
}

interface EvaluationFixture {
  path: string;
  oracle: EvaluationOracle;
}

async function fixtureRoots(selected: string | null): Promise<EvaluationFixture[]> {
  const root = fileURLToPath(new URL("../../fixtures/eval/", import.meta.url));
  if (selected) {
    const path = isAbsolute(selected) ? selected : join(root, selected);
    return [{ path, oracle: await loadEvaluationOracle(join(path, "oracle.json")) }];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const fixtures: EvaluationFixture[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    try {
      await access(join(path, "oracle.json"));
    } catch {
      // Evaluation roots without an oracle are deliberately not runnable.
      continue;
    }
    fixtures.push({ path, oracle: await loadEvaluationOracle(join(path, "oracle.json")) });
  }
  if (fixtures.length === 0) throw new Error(`No evaluation fixtures found under ${root}.`);
  return fixtures;
}

async function runWorker(
  provider: EvaluationProvider,
  fixture: string,
  scipCli: string | null,
): Promise<ProviderEvaluationReport> {
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const env = {
    ...process.env,
    SDLC_NATIVE: provider === "typescript-fallback" ? "0" : "1",
  };
  const result = await exec(
    process.execPath,
    [worker, provider, fixture, ...(provider.startsWith("scip-") && scipCli ? [scipCli] : [])],
    {
      env,
      timeout: 20 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.exitCode !== 0 || result.spawnFailed || result.timedOut || result.truncated) {
    throw new Error(
      `${provider} evaluation worker failed: ${result.stderr || result.stdout || "no diagnostics"}`,
    );
  }
  return JSON.parse(result.stdout) as ProviderEvaluationReport;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = await fixtureRoots(options.fixture);
  const requiresScip = fixtures.some((fixture) =>
    fixture.oracle.providers.some((provider) => provider.startsWith("scip-")),
  );
  const scip = await scipCliStatus({
    ...options,
    requireScipCli: options.requireScipCli && requiresScip,
  });
  const scenarios = [];
  for (const fixture of fixtures) {
    const providers: ProviderEvaluationReport[] = [];
    for (const provider of fixture.oracle.providers) {
      providers.push(await runWorker(provider, fixture.path, scip.available ? scip.path : null));
    }
    scenarios.push({
      scenario: providers[0]?.scenario ?? fixture.oracle.scenario,
      fixture: basename(fixture.path),
      languages: fixture.oracle.languages,
      entryToEffectOracle: fixture.oracle.entryToEffect
        ? {
            entrypoints: fixture.oracle.entryToEffect.entrypoints.length,
            relations: fixture.oracle.entryToEffect.relations.length,
            paths: fixture.oracle.entryToEffect.paths.length,
            scoring: "unmeasured" as const,
          }
        : null,
      passed: providers.every((provider) => provider.passed),
      providers,
    });
  }

  const failures = scenarios.flatMap((scenario) =>
    scenario.providers.flatMap((provider) =>
      provider.failures.map((failure) => `${scenario.scenario}/${provider.provider}: ${failure}`),
    ),
  );
  if (requiresScip && scip.required && !scip.available) {
    failures.push("The official SCIP CLI is required but was not found or could not report a version.");
  }
  if (
    requiresScip &&
    scip.required &&
    scenarios.some((scenario) =>
      scenario.providers.some(
        (provider) =>
          provider.provider.startsWith("scip-") &&
          provider.officialScipTest?.status !== "passed",
      ),
    )
  ) {
    failures.push("At least one official scip test validation did not pass.");
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    officialScipCli: scip,
    scenarios,
    summary: {
      passed: failures.length === 0,
      failures,
      measured: [
        "targeted symbol precision and recall",
        "targeted resolved-reference precision and recall",
        "cold, warm, and one-file-change syntax/compiler timing where supported",
        "workspace-store and SCIP artifact size",
        "isolated worker peak RSS",
      ],
      explicitlyUnmeasured: [
        "entry-to-effect path precision and recall",
        "retrieval recall, evidence coverage, token packing, and irrelevant-context rate",
        "external SCIP child peak RSS",
      ],
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

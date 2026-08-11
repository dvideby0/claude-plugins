/**
 * Linters and type checkers.
 *
 * Only the project's own toolchain is used — never a global fallback and never
 * npx (which can reach the network). A tool that isn't installed is reported
 * as skipped, never as a clean run.
 */

import { access, constants, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { exec, platformCommand, spawnEnv } from "../lib/exec.js";
import type { Category, FindingInput, Severity } from "../findings/types.js";

export interface AnalyzerOutcome {
  tool: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
  findings: FindingInput[];
}

export interface LocalToolCommand {
  command: string;
  /** Arguments that select the tool before its invocation-specific arguments. */
  prefixArgs?: string[];
  platform: NodeJS.Platform;
  comspec: string;
}

const TIMEOUT = 180_000;

async function canExec(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Turn an npm batch shim into an execFile-safe command on Windows. */
export function localToolCommand(
  path: string,
  batch: boolean,
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
): LocalToolCommand {
  // Keep the executable separate until the complete argv is known; otherwise
  // arguments appended after `/c` bypass cmd.exe escaping.
  return { command: path, platform: platform === "win32" && batch ? "win32" : platform, comspec };
}

/** Run POSIX npm bin scripts through the daemon's known Node/Electron runtime. */
export function nodeToolCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
  runtime = process.execPath,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
): LocalToolCommand {
  if (platform === "win32") return localToolCommand(path, true, platform, comspec);
  return { command: runtime, prefixArgs: [path], platform, comspec };
}

async function nodeBin(projectRoot: string, name: string): Promise<LocalToolCommand | null> {
  const batch = process.platform === "win32";
  const local = join(projectRoot, "node_modules", ".bin", `${name}${batch ? ".cmd" : ""}`);
  return (await canExec(local)) ? nodeToolCommand(local) : null;
}

async function pythonBin(projectRoot: string, name: string): Promise<LocalToolCommand | null> {
  // Project toolchain only, per the contract at the top of this file: a
  // global ruff or mypy of a different version produces findings the
  // project's own pin would not, and closes ones it would have kept.
  for (const dir of [".venv/bin", "venv/bin", ".venv/Scripts", "venv/Scripts"]) {
    const local = join(projectRoot, dir, `${name}${process.platform === "win32" ? ".exe" : ""}`);
    if (await canExec(local)) return localToolCommand(local, false);
  }
  return null;
}

function runLocal(
  tool: LocalToolCommand,
  args: string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal },
) {
  const command = platformCommand(
    tool.command,
    [...(tool.prefixArgs ?? []), ...args],
    tool.platform,
    tool.comspec,
  );
  return exec(command.command, command.args, {
    ...options,
    // Project tools may spawn node/npm themselves. Finder-launched macOS apps
    // inherit a minimal launchd PATH, so give those descendants the same
    // augmented environment as harness detection.
    env: spawnEnv(),
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function rel(projectRoot: string, path: string): string {
  const cleaned = path.trim();
  const result = isAbsolute(cleaned) ? relative(projectRoot, cleaned) : cleaned;
  // The index stores POSIX paths; a win32 separator here would silently miss
  // every content lookup, fixture demotion and fingerprint match.
  return result.replaceAll("\\", "/");
}

function skipped(tool: string, detail: string): AnalyzerOutcome {
  return { tool, status: "skipped", detail, findings: [] };
}

function failed(tool: string, detail: string): AnalyzerOutcome {
  return { tool, status: "failed", detail, findings: [] };
}

// --- ESLint ----------------------------------------------------------------

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  endLine?: number;
}

async function runEslint(projectRoot: string, signal?: AbortSignal): Promise<AnalyzerOutcome> {
  if (!(await exists(join(projectRoot, "package.json")))) {
    return skipped("eslint", "no package.json");
  }
  const bin = await nodeBin(projectRoot, "eslint");
  if (!bin) return skipped("eslint", "not installed in node_modules/.bin");

  const result = await runLocal(bin, [".", "--format", "json", "--no-error-on-unmatched-pattern"], {
    cwd: projectRoot,
    timeout: TIMEOUT,
    signal,
  });
  if (result.timedOut) return failed("eslint", "timed out");
  if (result.spawnFailed) return failed("eslint", "could not execute");
  if (result.truncated) return failed("eslint", result.stderr);
  if (!result.stdout.trim()) {
    return result.exitCode === 0
      ? { tool: "eslint", status: "ok", detail: "no output", findings: [] }
      : failed("eslint", result.stderr.split("\n")[0] || `exit ${result.exitCode}`);
  }

  let report: Array<{ filePath: string; messages: EslintMessage[] }>;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return failed("eslint", "unparseable json output");
  }

  const findings: FindingInput[] = [];
  for (const file of report) {
    for (const message of file.messages ?? []) {
      const ruleId = message.ruleId ?? "parse-error";
      findings.push({
        ruleId: `eslint/${ruleId}`,
        category: /security|no-eval|no-implied-eval/.test(ruleId) ? "security" : "maintainability",
        severity: message.severity === 2 ? "high" : "medium",
        confidence: "definite",
        source: "linter",
        title: `${ruleId}: ${message.message}`,
        description: message.message,
        path: rel(projectRoot, file.filePath),
        lineStart: message.line,
        lineEnd: message.endLine ?? message.line,
        symbol: ruleId,
      });
    }
  }
  return { tool: "eslint", status: "ok", detail: `${findings.length} findings`, findings };
}

// --- TypeScript ------------------------------------------------------------

interface ConfigInspection {
  hasFiles: boolean;
  issue: string | null;
}

const MAX_TSCONFIG_BYTES = 1024 * 1024;

/** Read JSONC without letting syntax-only discovery allocate without bound. */
async function readBoundedConfig(configPath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(configPath, "r");
  try {
    const buffer = Buffer.alloc(MAX_TSCONFIG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    if (bytesRead > MAX_TSCONFIG_BYTES) {
      throw new Error(`config exceeds the ${MAX_TSCONFIG_BYTES}-byte safety limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await file.close();
  }
}

/** Does this TypeScript-family config actually check files, per the compiler itself? */
async function inspectTsConfig(
  configPath: string,
  signal?: AbortSignal,
  expandFiles = true,
): Promise<ConfigInspection> {
  signal?.throwIfAborted();
  try {
    const ts = await import("typescript");
    signal?.throwIfAborted();
    if (!expandFiles) {
      // Precise providers own project/reference resolution. Validate only the
      // bounded JSONC input here; expanding include globs with ts.sys would do
      // an unbounded synchronous filesystem walk on the daemon thread.
      const raw = ts.parseConfigFileTextToJson(
        configPath,
        await readBoundedConfig(configPath, signal),
      );
      return {
        hasFiles: !raw.error,
        issue: raw.error ? ts.flattenDiagnosticMessageText(raw.error.messageText, " ") : null,
      };
    }
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (raw.error) {
      return {
        hasFiles: false,
        issue: ts.flattenDiagnosticMessageText(raw.error.messageText, " "),
      };
    }
    const parsed = ts.parseJsonConfigFileContent(
      raw.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );
    signal?.throwIfAborted();
    const blocking = parsed.errors.filter((error) => error.code !== 18003);
    return {
      hasFiles: parsed.fileNames.length > 0,
      issue:
        parsed.fileNames.length === 0 && blocking.length > 0
          ? ts.flattenDiagnosticMessageText(blocking[0]!.messageText, " ")
          : null,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { hasFiles: false, issue: error instanceof Error ? error.message : String(error) };
  }
}

const TSC_DISCOVERY_SKIP = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

export interface TsConfigDiscovery {
  /** Directories containing configs that actually own source files. */
  roots: string[];
  /** Exact config paths; providers need these to preserve jsconfig semantics. */
  configs: string[];
  /** Configs that could not be parsed or did not yield a valid project. */
  issues: Array<{ config: string; message: string }>;
  /** Number of candidate config files encountered, including empty/invalid ones. */
  found: number;
  /** More projects exist than the checker can safely run in one pass. */
  capped: boolean;
}

/**
 * Find every real TypeScript project, including nested and nonstandard
 * workspace layouts. A root config may cover only the app shell while child
 * configs own packages, so finding one never short-circuits discovery.
 */
export async function findTsConfigs(
  projectRoot: string,
  limit = 64,
  signal?: AbortSignal,
  configNames: readonly string[] = ["tsconfig.json"],
  expandFiles = true,
): Promise<TsConfigDiscovery> {
  const roots: string[] = [];
  const configs: string[] = [];
  const issues: Array<{ config: string; message: string }> = [];
  const names = new Set(configNames);
  let found = 0;
  let capped = false;

  async function visit(dir: string): Promise<void> {
    signal?.throwIfAborted();
    if (capped) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      signal?.throwIfAborted();
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.isFile() && names.has(entry.name)) {
        found++;
        if (found > limit) {
          capped = true;
          return;
        }
        const configPath = join(dir, entry.name);
        // Solution-style configs with only references check no files
        // themselves; their referenced child configs are discovered below.
        const inspection = await inspectTsConfig(configPath, signal, expandFiles);
        if (inspection.hasFiles) {
          roots.push(dir);
          configs.push(configPath);
        } else if (inspection.issue) {
          issues.push({ config: configPath, message: inspection.issue });
        }
      } else if (entry.isDirectory() && !TSC_DISCOVERY_SKIP.has(entry.name)) {
        await visit(join(dir, entry.name));
        if (capped) return;
      }
    }
  }

  await visit(projectRoot);
  roots.sort((a, b) => {
    if (a === projectRoot) return -1;
    if (b === projectRoot) return 1;
    return a.localeCompare(b);
  });
  configs.sort((a, b) => {
    if (dirname(a) === projectRoot) return -1;
    if (dirname(b) === projectRoot) return 1;
    return a.localeCompare(b);
  });
  issues.sort((a, b) => a.config.localeCompare(b.config));
  return { roots, configs, issues, found, capped };
}

async function runTsc(projectRoot: string, signal?: AbortSignal): Promise<AnalyzerOutcome> {
  const discovery = await findTsConfigs(projectRoot, 64, signal);
  const { roots } = discovery;
  if (roots.length === 0) {
    if (discovery.issues.length > 0) {
      return failed(
        "tsc",
        discovery.issues.map((issue) => `${rel(projectRoot, issue.config)}: ${issue.message}`).join("; "),
      );
    }
    return skipped("tsc", "no tsconfig.json at the root or in packages/apps");
  }
  const bin = await nodeBin(projectRoot, "tsc");
  if (!bin) return skipped("tsc", "typescript not installed in project");

  const findings: FindingInput[] = [];
  const line = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
  const failures: string[] = discovery.issues.map(
    (issue) => `${rel(projectRoot, issue.config)}: ${issue.message}`,
  );
  if (discovery.capped) {
    failures.push(`project discovery exceeded the ${roots.length}-config safety cap`);
  }

  for (const root of roots) {
    const result = await runLocal(bin, ["--noEmit", "--pretty", "false"], {
      cwd: root,
      timeout: TIMEOUT,
      signal,
    });
    const name = rel(projectRoot, root) || ".";
    if (result.timedOut) {
      failures.push(`${name}: timed out`);
      continue;
    }
    if (result.spawnFailed) {
      failures.push(`${name}: could not execute`);
      continue;
    }
    if (result.truncated) {
      failures.push(`${name}: ${result.stderr}`);
      continue;
    }

    const before = findings.length;
    for (const raw of `${result.stdout}\n${result.stderr}`.split("\n")) {
      const match = line.exec(raw.trim());
      if (!match) continue;
      findings.push({
        ruleId: `tsc/${match[4]}`,
        category: "types",
        severity: "high",
        confidence: "definite",
        source: "typecheck",
        title: `${match[4]}: ${match[5]}`,
        description: match[5],
        // Paths are relative to the config that produced them, not the repo.
        path: rel(projectRoot, join(root, match[1] as string)),
        lineStart: Number(match[2]),
        lineEnd: Number(match[2]),
        symbol: match[4],
      });
    }

    // Nonzero exit with no per-file diagnostics is a config-level error
    // (TS18003, composite rejecting --noEmit, …) — the project was not
    // checked, and saying "0 errors" here is how real findings get closed.
    if (result.exitCode !== 0 && findings.length === before) {
      const reason =
        `${result.stdout}\n${result.stderr}`
          .split("\n")
          .map((l) => l.trim())
          .find(Boolean) ?? `exit ${result.exitCode}`;
      failures.push(`${name}: ${reason}`);
    }
  }

  // Anywhere the checker could not run is a gap, not a clean result: an "ok"
  // here closes every previously recorded tsc finding, including in the
  // projects that were never checked this run.
  if (failures.length > 0) {
    return {
      tool: "tsc",
      status: "failed",
      detail:
        `${failures.length} of ${roots.length} project(s) failed: ${failures.join("; ")}` +
        (findings.length ? ` (${findings.length} errors still recorded)` : ""),
      findings,
    };
  }

  const where = roots.length === 1 ? "" : ` across ${roots.length} projects`;
  return { tool: "tsc", status: "ok", detail: `${findings.length} errors${where}`, findings };
}

// --- Ruff ------------------------------------------------------------------

interface RuffDiagnostic {
  code: string | null;
  message: string;
  filename: string;
  location?: { row: number };
  end_location?: { row: number };
}

function ruffSeverity(code: string): { severity: Severity; category: Category } {
  if (code.startsWith("S")) return { severity: "high", category: "security" };
  if (code.startsWith("F") || code.startsWith("E9")) return { severity: "high", category: "correctness" };
  if (code.startsWith("B")) return { severity: "medium", category: "correctness" };
  return { severity: "medium", category: "maintainability" };
}

async function runRuff(projectRoot: string, signal?: AbortSignal): Promise<AnalyzerOutcome> {
  const hasPython =
    (await exists(join(projectRoot, "pyproject.toml"))) ||
    (await exists(join(projectRoot, "requirements.txt"))) ||
    (await exists(join(projectRoot, "setup.py")));
  if (!hasPython) return skipped("ruff", "no python manifest");

  const bin = await pythonBin(projectRoot, "ruff");
  if (!bin) return skipped("ruff", "not installed");

  const result = await runLocal(bin, ["check", ".", "--output-format", "json"], {
    cwd: projectRoot,
    timeout: TIMEOUT,
    signal,
  });
  if (result.timedOut) return failed("ruff", "timed out");
  if (result.spawnFailed) return failed("ruff", "could not execute");
  if (result.truncated) return failed("ruff", result.stderr);
  if (!result.stdout.trim()) {
    // ruff exits 0 on clean, 1 with findings; anything else (2 = broken
    // config, bad CLI args) means it never checked the code.
    return result.exitCode === 0
      ? { tool: "ruff", status: "ok", detail: "no findings", findings: [] }
      : failed("ruff", result.stderr.split("\n")[0] || `exit ${result.exitCode}`);
  }

  let report: RuffDiagnostic[];
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return failed("ruff", "unparseable json output");
  }

  const findings = report.map((diagnostic) => {
    const code = diagnostic.code ?? "RUF";
    const { severity, category } = ruffSeverity(code);
    return {
      ruleId: `ruff/${code}`,
      category,
      severity,
      confidence: "definite",
      source: "linter",
      title: `${code}: ${diagnostic.message}`,
      description: diagnostic.message,
      path: rel(projectRoot, diagnostic.filename),
      lineStart: diagnostic.location?.row,
      lineEnd: diagnostic.end_location?.row ?? diagnostic.location?.row,
      symbol: code,
    } satisfies FindingInput;
  });

  return { tool: "ruff", status: "ok", detail: `${findings.length} findings`, findings };
}

// --- mypy ------------------------------------------------------------------

async function runMypy(projectRoot: string, signal?: AbortSignal): Promise<AnalyzerOutcome> {
  if (!(await exists(join(projectRoot, "pyproject.toml"))) &&
      !(await exists(join(projectRoot, "mypy.ini")))) {
    return skipped("mypy", "no mypy config");
  }
  const bin = await pythonBin(projectRoot, "mypy");
  if (!bin) return skipped("mypy", "not installed");

  const result = await runLocal(bin, [".", "--no-error-summary", "--no-color-output"], {
    cwd: projectRoot,
    timeout: TIMEOUT,
    signal,
  });
  if (result.timedOut) return failed("mypy", "timed out");
  if (result.spawnFailed) return failed("mypy", "could not execute");
  if (result.truncated) return failed("mypy", result.stderr);

  const findings: FindingInput[] = [];
  const line = /^(.+?):(\d+): error: (.+?)(?:\s+\[([\w-]+)\])?$/;
  for (const raw of result.stdout.split("\n")) {
    const match = line.exec(raw.trim());
    if (!match) continue;
    const code = match[4] ?? "error";
    findings.push({
      ruleId: `mypy/${code}`,
      category: "types",
      severity: "high",
      confidence: "definite",
      source: "typecheck",
      title: `${code}: ${match[3]}`,
      description: match[3],
      path: rel(projectRoot, match[1]),
      lineStart: Number(match[2]),
      lineEnd: Number(match[2]),
      symbol: code,
    });
  }

  // mypy exits 0 on clean, 1 with errors; 2 is "could not check" (duplicate
  // module names, bad config — messages with no line number, so the regex
  // above sees nothing). Reporting that as "0 errors" closes real findings.
  if (result.exitCode !== 0 && findings.length === 0) {
    const reason =
      `${result.stdout}\n${result.stderr}`
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean) ?? `exit ${result.exitCode}`;
    return failed("mypy", reason);
  }

  return { tool: "mypy", status: "ok", detail: `${findings.length} errors`, findings };
}

export async function runProjectTools(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<AnalyzerOutcome[]> {
  signal?.throwIfAborted();
  return Promise.all([
    runEslint(projectRoot, signal),
    runTsc(projectRoot, signal),
    runRuff(projectRoot, signal),
    runMypy(projectRoot, signal),
  ]);
}

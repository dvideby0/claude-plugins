/**
 * Linters and type checkers.
 *
 * Only the project's own toolchain is used — never a global fallback and never
 * npx (which can reach the network). A tool that isn't installed is reported
 * as skipped, never as a clean run.
 */

import { access, constants, readdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { exec } from "../lib/exec.js";
import type { Category, FindingInput, Severity } from "../findings/types.js";

export interface AnalyzerOutcome {
  tool: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
  findings: FindingInput[];
}

export interface LocalToolCommand {
  command: string;
  argsPrefix: string[];
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
  return platform === "win32" && batch
    ? { command: comspec, argsPrefix: ["/d", "/s", "/c", path] }
    : { command: path, argsPrefix: [] };
}

async function nodeBin(projectRoot: string, name: string): Promise<LocalToolCommand | null> {
  const batch = process.platform === "win32";
  const local = join(projectRoot, "node_modules", ".bin", `${name}${batch ? ".cmd" : ""}`);
  return (await canExec(local)) ? localToolCommand(local, batch) : null;
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
  options: { cwd: string; timeout: number },
) {
  return exec(tool.command, [...tool.argsPrefix, ...args], options);
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

async function runEslint(projectRoot: string): Promise<AnalyzerOutcome> {
  if (!(await exists(join(projectRoot, "package.json")))) {
    return skipped("eslint", "no package.json");
  }
  const bin = await nodeBin(projectRoot, "eslint");
  if (!bin) return skipped("eslint", "not installed in node_modules/.bin");

  const result = await runLocal(bin, [".", "--format", "json", "--no-error-on-unmatched-pattern"], {
    cwd: projectRoot,
    timeout: TIMEOUT,
  });
  if (result.timedOut) return failed("eslint", "timed out");
  if (result.spawnFailed) return failed("eslint", "could not execute");
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

/** Does this tsconfig actually check any files, per the compiler itself? */
async function tsConfigHasFiles(dir: string): Promise<boolean> {
  try {
    const ts = await import("typescript");
    const configPath = join(dir, "tsconfig.json");
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (raw.error) return false;
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dir);
    return parsed.fileNames.length > 0;
  } catch {
    return false;
  }
}

/**
 * Project configs, root first and then one level of workspace packages.
 *
 * A monorepo has no tsconfig.json at its root — each package carries its own.
 * Looking only at the root meant type checking silently skipped on exactly the
 * repositories where it matters most, and reported that as "no tsconfig.json"
 * rather than as a gap. A root config that exists but names no files — the
 * solution-style `{"files": [], "references": [...]}` shape — is the same
 * trap: tsc exits 0 there having checked nothing, so the packages are what
 * must be checked.
 */
async function findTsConfigs(projectRoot: string, limit = 12): Promise<string[]> {
  if (
    (await exists(join(projectRoot, "tsconfig.json"))) &&
    (await tsConfigHasFiles(projectRoot))
  ) {
    return [projectRoot];
  }

  const found: string[] = [];
  for (const group of ["packages", "apps", "libs", "services"]) {
    const base = join(projectRoot, group);
    if (!(await exists(base))) continue;
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      const dir = join(base, entry);
      if (await exists(join(dir, "tsconfig.json"))) found.push(dir);
    }
  }
  return found;
}

async function runTsc(projectRoot: string): Promise<AnalyzerOutcome> {
  const roots = await findTsConfigs(projectRoot);
  if (roots.length === 0) {
    return skipped("tsc", "no tsconfig.json at the root or in packages/apps");
  }
  const bin = await nodeBin(projectRoot, "tsc");
  if (!bin) return skipped("tsc", "typescript not installed in project");

  const findings: FindingInput[] = [];
  const line = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
  const failures: string[] = [];

  for (const root of roots) {
    const result = await runLocal(bin, ["--noEmit", "--pretty", "false"], {
      cwd: root,
      timeout: TIMEOUT,
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

async function runRuff(projectRoot: string): Promise<AnalyzerOutcome> {
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
  });
  if (result.timedOut) return failed("ruff", "timed out");
  if (result.spawnFailed) return failed("ruff", "could not execute");
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

async function runMypy(projectRoot: string): Promise<AnalyzerOutcome> {
  if (!(await exists(join(projectRoot, "pyproject.toml"))) &&
      !(await exists(join(projectRoot, "mypy.ini")))) {
    return skipped("mypy", "no mypy config");
  }
  const bin = await pythonBin(projectRoot, "mypy");
  if (!bin) return skipped("mypy", "not installed");

  const result = await runLocal(bin, [".", "--no-error-summary", "--no-color-output"], {
    cwd: projectRoot,
    timeout: TIMEOUT,
  });
  if (result.timedOut) return failed("mypy", "timed out");
  if (result.spawnFailed) return failed("mypy", "could not execute");

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

export async function runProjectTools(projectRoot: string): Promise<AnalyzerOutcome[]> {
  return Promise.all([
    runEslint(projectRoot),
    runTsc(projectRoot),
    runRuff(projectRoot),
    runMypy(projectRoot),
  ]);
}

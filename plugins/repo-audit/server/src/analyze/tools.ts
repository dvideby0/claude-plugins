/**
 * Linters and type checkers.
 *
 * Only the project's own toolchain is used — never a global fallback and never
 * npx (which can reach the network). A tool that isn't installed is reported
 * as skipped, never as a clean run.
 */

import { access, constants } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { exec } from "../lib/exec.js";
import { which } from "../lib/exec.js";
import type { Category, FindingInput, Severity } from "../findings/types.js";

export interface AnalyzerOutcome {
  tool: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
  findings: FindingInput[];
}

const TIMEOUT = 180_000;

async function canExec(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function nodeBin(projectRoot: string, name: string): Promise<string | null> {
  const local = join(projectRoot, "node_modules", ".bin", name);
  return (await canExec(local)) ? local : null;
}

async function pythonBin(projectRoot: string, name: string): Promise<string | null> {
  for (const dir of [".venv/bin", "venv/bin"]) {
    const local = join(projectRoot, dir, name);
    if (await canExec(local)) return local;
  }
  return which(name);
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
  return isAbsolute(cleaned) ? relative(projectRoot, cleaned) : cleaned;
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

  const result = await exec(bin, [".", "--format", "json", "--no-error-on-unmatched-pattern"], {
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

async function runTsc(projectRoot: string): Promise<AnalyzerOutcome> {
  if (!(await exists(join(projectRoot, "tsconfig.json")))) {
    return skipped("tsc", "no tsconfig.json");
  }
  const bin = await nodeBin(projectRoot, "tsc");
  if (!bin) return skipped("tsc", "typescript not installed in project");

  const result = await exec(bin, ["--noEmit", "--pretty", "false"], {
    cwd: projectRoot,
    timeout: TIMEOUT,
  });
  if (result.timedOut) return failed("tsc", "timed out");
  if (result.spawnFailed) return failed("tsc", "could not execute");

  const findings: FindingInput[] = [];
  const line = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
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
      path: rel(projectRoot, match[1]),
      lineStart: Number(match[2]),
      lineEnd: Number(match[2]),
      symbol: match[4],
    });
  }
  return { tool: "tsc", status: "ok", detail: `${findings.length} errors`, findings };
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

  const result = await exec(bin, ["check", ".", "--output-format", "json"], {
    cwd: projectRoot,
    timeout: TIMEOUT,
  });
  if (result.timedOut) return failed("ruff", "timed out");
  if (result.spawnFailed) return failed("ruff", "could not execute");
  if (!result.stdout.trim()) {
    return { tool: "ruff", status: "ok", detail: "no findings", findings: [] };
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

  const result = await exec(bin, [".", "--no-error-summary", "--no-color-output"], {
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

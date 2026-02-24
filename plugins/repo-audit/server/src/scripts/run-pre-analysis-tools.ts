/**
 * Pre-Analysis Tool Runner.
 * Migrated from scripts/run-pre-analysis-tools.sh (420 LOC).
 *
 * Orchestrates 20+ deterministic tool invocations:
 * - Code metrics (cloc/tokei)
 * - Git analysis
 * - Linters (eslint, ruff, biome, golangci-lint, rubocop)
 * - Type checkers (tsc, go vet, cargo check)
 * - Dependency auditors (npm/yarn/pnpm audit, pip-audit, cargo-audit, govulncheck, bundle-audit, composer audit)
 * - Skeleton extractors (TypeScript, Go, Rust, Java, Python)
 *
 * Always succeeds — failures are logged to pre-analysis-failures.log.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runScript } from "../lib/subprocess.js";
import { runGitAnalysis } from "./git-analysis.js";
import {
  extractTypescriptSkeletons,
  extractGoSkeletons,
  extractRustSkeletons,
  extractJavaSkeletons,
  extractPythonSkeletons,
} from "./skeletons/index.js";
import type { ToolAvailability } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreAnalysisOptions {
  projectRoot: string;
}

export interface PreAnalysisResult {
  successCount: number;
  failureCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(cmd: string): Promise<boolean> {
  try {
    await runScript("which", [cmd], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an external tool, capturing output to a file.
 * Returns true on success, false on failure.
 */
async function runTool(
  name: string,
  outputFile: string,
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; truncateLines?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeout = options.timeout ?? 60_000;

  try {
    const result = await runScript(command, args, {
      cwd: options.cwd,
      timeout,
    });

    let output = result.stdout;
    if (options.truncateLines) {
      const lines = output.split("\n");
      if (lines.length > options.truncateLines) {
        output = lines.slice(0, options.truncateLines).join("\n");
      }
    }

    await writeFile(outputFile, output);
    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Some tools (npm audit, tsc) exit non-zero as expected.
    // If we got stderr/stdout, still write it.
    const errObj = err as Record<string, unknown> | null;
    if (errObj && typeof errObj === "object" && "stdout" in errObj) {
      const stdout = String(errObj.stdout ?? "");
      const stderr = String(errObj.stderr ?? "");
      if (stdout || stderr) {
        let output = stdout || stderr;
        if (options.truncateLines) {
          const lines = output.split("\n");
          if (lines.length > options.truncateLines) {
            output = lines.slice(0, options.truncateLines).join("\n");
          }
        }
        await writeFile(outputFile, output);
        // If we got output, consider it a "success" — the tool ran
        return { ok: true };
      }
    }

    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Tool availability reading
// ---------------------------------------------------------------------------

async function loadToolAvailability(
  dataDir: string,
): Promise<ToolAvailability | null> {
  try {
    const raw = await readFile(join(dataDir, "tool-availability.json"), "utf-8");
    return JSON.parse(raw) as ToolAvailability;
  } catch {
    return null;
  }
}

function isToolAvailable(
  toolAvail: ToolAvailability | null,
  tool: string,
): boolean {
  if (!toolAvail) return false;
  return toolAvail.tools?.[tool]?.available === true;
}

function isProjectToolAvailable(
  toolAvail: ToolAvailability | null,
  tool: string,
): boolean {
  if (!toolAvail) return false;
  return toolAvail.project_tools?.[tool]?.available === true;
}

async function loadDetectedLanguages(dataDir: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(dataDir, "detection.json"), "utf-8");
    const det = JSON.parse(raw);
    const langs = new Set<string>();
    for (const lang of det.primary_languages ?? []) {
      langs.add(lang);
    }
    // Also check all_directories for language coverage
    for (const info of Object.values(det.all_directories ?? {}) as Array<{ languages?: string[] }>) {
      for (const lang of info.languages ?? []) {
        langs.add(lang);
      }
    }
    return langs;
  } catch {
    return new Set();
  }
}

function hasLanguage(languages: Set<string>, lang: string): boolean {
  // Case-insensitive check
  const lower = lang.toLowerCase();
  for (const l of languages) {
    if (l.toLowerCase() === lower) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runPreAnalysisTools(
  options: PreAnalysisOptions,
): Promise<PreAnalysisResult> {
  const { projectRoot } = options;
  const auditDir = join(projectRoot, "sdlc-audit");
  const dataDir = join(auditDir, "data");
  const toolOutput = join(auditDir, "tool-output");
  const failLog = join(dataDir, "pre-analysis-failures.log");

  // Setup directories
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(toolOutput, "linter-results"), { recursive: true });
  await mkdir(join(toolOutput, "typecheck"), { recursive: true });
  await mkdir(join(toolOutput, "deps"), { recursive: true });
  await mkdir(join(dataDir, "skeletons"), { recursive: true });

  // Initialize failure log
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const logLines: string[] = [
    "# Pre-Analysis Failure Log",
    `# Generated: ${timestamp}`,
    `# Project: ${projectRoot}`,
    "",
  ];

  let successCount = 0;
  let failureCount = 0;

  function logSuccess(): void {
    successCount++;
  }

  function logFailure(name: string, error: string): void {
    failureCount++;
    const time = new Date().toISOString().slice(11, 19);
    logLines.push(`[${time}] ${name} — failed`);
    if (error) {
      const truncated = error.split("\n").slice(0, 20).join("\n");
      logLines.push(`  error: ${truncated}`);
    }
    logLines.push("");
  }

  // Load tool availability and language detection
  const toolAvail = await loadToolAvailability(dataDir);
  const languages = await loadDetectedLanguages(dataDir);

  // ------------------------------------------------------------------
  // Code Metrics (cloc or tokei)
  // ------------------------------------------------------------------
  if (isToolAvailable(toolAvail, "cloc")) {
    const result = await runTool(
      "cloc", join(dataDir, "metrics.json"),
      "cloc",
      [
        projectRoot, "--json", "--by-file",
        "--exclude-dir=node_modules,dist,build,.venv,venv,.next,target,obj,vendor,__pycache__,.git,coverage,deps,_build,.dart_tool,Pods,sdlc-audit",
      ],
      { cwd: projectRoot, timeout: 120_000 },
    );
    if (result.ok) logSuccess(); else logFailure("cloc", result.error ?? "");
  } else if (isToolAvailable(toolAvail, "tokei")) {
    const result = await runTool(
      "tokei", join(dataDir, "metrics.json"),
      "tokei",
      [
        projectRoot, "--output", "json",
        "--exclude", "node_modules", "dist", "build", ".venv", "target", "obj", "vendor", "sdlc-audit",
      ],
      { cwd: projectRoot, timeout: 120_000 },
    );
    if (result.ok) logSuccess(); else logFailure("tokei", result.error ?? "");
  }

  // ------------------------------------------------------------------
  // Git History Analysis
  // ------------------------------------------------------------------
  if (await fileExists(join(projectRoot, ".git"))) {
    try {
      await runGitAnalysis(projectRoot);
      logSuccess();
    } catch (err) {
      logFailure("git-analysis", err instanceof Error ? err.message : String(err));
    }
  }

  // ------------------------------------------------------------------
  // Linters
  // ------------------------------------------------------------------

  // ESLint
  const hasPackageJson = await fileExists(join(projectRoot, "package.json"));
  const hasLocalEslint = await fileExists(join(projectRoot, "node_modules", ".bin", "eslint"));
  if (hasPackageJson && (hasLocalEslint || await commandAvailable("eslint"))) {
    const eslintCmd = hasLocalEslint ? "npx" : "eslint";
    const eslintArgs = hasLocalEslint
      ? ["eslint", ".", "--format", "json"]
      : [".", "--format", "json"];
    const result = await runTool(
      "eslint", join(toolOutput, "linter-results", "eslint.json"),
      eslintCmd, eslintArgs,
      { cwd: projectRoot, timeout: 120_000, truncateLines: 5000 },
    );
    if (result.ok) logSuccess(); else logFailure("eslint", result.error ?? "");
  }

  // Ruff
  const hasRuffConfig = (await fileExists(join(projectRoot, "pyproject.toml")))
    || (await fileExists(join(projectRoot, "ruff.toml")));
  if (hasRuffConfig && (isProjectToolAvailable(toolAvail, "ruff") || await commandAvailable("ruff"))) {
    const result = await runTool(
      "ruff", join(toolOutput, "linter-results", "ruff.json"),
      "ruff", ["check", ".", "--output-format", "json"],
      { cwd: projectRoot, timeout: 60_000, truncateLines: 5000 },
    );
    if (result.ok) logSuccess(); else logFailure("ruff", result.error ?? "");
  }

  // Biome
  const hasBiomeConfig = await fileExists(join(projectRoot, "biome.json"));
  const hasLocalBiome = await fileExists(join(projectRoot, "node_modules", ".bin", "biome"));
  if (hasBiomeConfig && hasLocalBiome) {
    const result = await runTool(
      "biome", join(toolOutput, "linter-results", "biome.json"),
      "npx", ["biome", "check", ".", "--reporter", "json"],
      { cwd: projectRoot, timeout: 60_000, truncateLines: 5000 },
    );
    if (result.ok) logSuccess(); else logFailure("biome", result.error ?? "");
  }

  // golangci-lint
  if (await commandAvailable("golangci-lint") && await fileExists(join(projectRoot, ".golangci.yml"))) {
    const result = await runTool(
      "golangci-lint", join(toolOutput, "linter-results", "golangci.json"),
      "golangci-lint", ["run", "--out-format", "json"],
      { cwd: projectRoot, timeout: 120_000, truncateLines: 5000 },
    );
    if (result.ok) logSuccess(); else logFailure("golangci-lint", result.error ?? "");
  }

  // Rubocop
  if (await commandAvailable("rubocop") && await fileExists(join(projectRoot, ".rubocop.yml"))) {
    const result = await runTool(
      "rubocop", join(toolOutput, "linter-results", "rubocop.json"),
      "rubocop", ["--format", "json"],
      { cwd: projectRoot, timeout: 120_000, truncateLines: 5000 },
    );
    if (result.ok) logSuccess(); else logFailure("rubocop", result.error ?? "");
  }

  // ------------------------------------------------------------------
  // Type Checkers
  // ------------------------------------------------------------------

  // TypeScript
  const hasTsConfig = await fileExists(join(projectRoot, "tsconfig.json"));
  const hasLocalTsc = await fileExists(join(projectRoot, "node_modules", ".bin", "tsc"));
  if (hasTsConfig && (hasLocalTsc || await commandAvailable("tsc"))) {
    const result = await runTool(
      "tsc", join(toolOutput, "typecheck", "tsc.txt"),
      "npx", ["tsc", "--noEmit", "--pretty", "false"],
      { cwd: projectRoot, timeout: 120_000, truncateLines: 500 },
    );
    if (result.ok) logSuccess(); else logFailure("tsc", result.error ?? "");
  }

  // Go vet
  if (await fileExists(join(projectRoot, "go.mod")) && await commandAvailable("go")) {
    const result = await runTool(
      "go-vet", join(toolOutput, "typecheck", "govet.txt"),
      "go", ["vet", "./..."],
      { cwd: projectRoot, timeout: 120_000, truncateLines: 200 },
    );
    if (result.ok) logSuccess(); else logFailure("go-vet", result.error ?? "");
  }

  // Cargo check
  if (await fileExists(join(projectRoot, "Cargo.toml")) && await commandAvailable("cargo")) {
    const result = await runTool(
      "cargo-check", join(toolOutput, "typecheck", "cargo-check.txt"),
      "cargo", ["check", "--message-format", "short"],
      { cwd: projectRoot, timeout: 180_000, truncateLines: 200 },
    );
    if (result.ok) logSuccess(); else logFailure("cargo-check", result.error ?? "");
  }

  // ------------------------------------------------------------------
  // Dependency Vulnerability Audits
  // ------------------------------------------------------------------

  // npm audit
  if (await fileExists(join(projectRoot, "package-lock.json")) && await commandAvailable("npm")) {
    const result = await runTool(
      "npm-audit", join(toolOutput, "deps", "npm-audit.json"),
      "npm", ["audit", "--json"],
      { cwd: projectRoot, timeout: 60_000 },
    );
    if (result.ok) logSuccess(); else logFailure("npm-audit", result.error ?? "");
  }

  // yarn audit
  if (await fileExists(join(projectRoot, "yarn.lock")) && await commandAvailable("yarn")) {
    const result = await runTool(
      "yarn-audit", join(toolOutput, "deps", "yarn-audit.json"),
      "yarn", ["audit", "--json"],
      { cwd: projectRoot, timeout: 60_000 },
    );
    if (result.ok) logSuccess(); else logFailure("yarn-audit", result.error ?? "");
  }

  // pnpm audit
  if (await fileExists(join(projectRoot, "pnpm-lock.yaml")) && await commandAvailable("pnpm")) {
    const result = await runTool(
      "pnpm-audit", join(toolOutput, "deps", "pnpm-audit.json"),
      "pnpm", ["audit", "--json"],
      { cwd: projectRoot, timeout: 60_000 },
    );
    if (result.ok) logSuccess(); else logFailure("pnpm-audit", result.error ?? "");
  }

  // pip-audit
  const hasPythonManifest = (await fileExists(join(projectRoot, "requirements.txt")))
    || (await fileExists(join(projectRoot, "pyproject.toml")));
  if (hasPythonManifest && await commandAvailable("pip-audit")) {
    const result = await runTool(
      "pip-audit", join(toolOutput, "deps", "pip-audit.json"),
      "pip-audit", ["--format", "json"],
      { cwd: projectRoot, timeout: 120_000 },
    );
    if (result.ok) logSuccess(); else logFailure("pip-audit", result.error ?? "");
  }

  // cargo-audit
  if (await fileExists(join(projectRoot, "Cargo.lock")) && await commandAvailable("cargo-audit")) {
    const result = await runTool(
      "cargo-audit", join(toolOutput, "deps", "cargo-audit.json"),
      "cargo-audit", ["audit", "--json"],
      { cwd: projectRoot, timeout: 120_000 },
    );
    if (result.ok) logSuccess(); else logFailure("cargo-audit", result.error ?? "");
  }

  // govulncheck
  if (await fileExists(join(projectRoot, "go.sum")) && await commandAvailable("govulncheck")) {
    const result = await runTool(
      "govulncheck", join(toolOutput, "deps", "govulncheck.txt"),
      "govulncheck", ["./..."],
      { cwd: projectRoot, timeout: 120_000 },
    );
    if (result.ok) logSuccess(); else logFailure("govulncheck", result.error ?? "");
  }

  // bundle-audit
  if (await fileExists(join(projectRoot, "Gemfile.lock")) && await commandAvailable("bundle-audit")) {
    const result = await runTool(
      "bundle-audit", join(toolOutput, "deps", "bundle-audit.txt"),
      "bundle-audit", ["check"],
      { cwd: projectRoot, timeout: 60_000 },
    );
    if (result.ok) logSuccess(); else logFailure("bundle-audit", result.error ?? "");
  }

  // composer audit
  if (await fileExists(join(projectRoot, "composer.lock")) && await commandAvailable("composer")) {
    const result = await runTool(
      "composer-audit", join(toolOutput, "deps", "composer-audit.json"),
      "composer", ["audit", "--format", "json"],
      { cwd: projectRoot, timeout: 60_000 },
    );
    if (result.ok) logSuccess(); else logFailure("composer-audit", result.error ?? "");
  }

  // ------------------------------------------------------------------
  // Code Skeletons (direct TS function calls)
  // ------------------------------------------------------------------
  const skeletonJobs: Array<{ name: string; fn: () => Promise<unknown> }> = [];

  // TypeScript/JavaScript
  if (hasLanguage(languages, "TypeScript") || hasLanguage(languages, "JavaScript") || hasPackageJson) {
    skeletonJobs.push({
      name: "ts-skeletons",
      fn: () => extractTypescriptSkeletons(projectRoot),
    });
  }

  // Go
  if (hasLanguage(languages, "Go") || await fileExists(join(projectRoot, "go.mod"))) {
    skeletonJobs.push({
      name: "go-skeletons",
      fn: () => extractGoSkeletons(projectRoot),
    });
  }

  // Go doc (supplements grep-based skeletons with API docs)
  if (await fileExists(join(projectRoot, "go.mod")) && await commandAvailable("go")) {
    skeletonJobs.push({
      name: "go-doc",
      fn: async () => {
        await runTool(
          "go-doc", join(dataDir, "skeletons", "go-api.txt"),
          "go", ["doc", "-all", "./..."],
          { cwd: projectRoot, timeout: 30_000, truncateLines: 2000 },
        );
      },
    });
  }

  // Rust
  if (hasLanguage(languages, "Rust") || await fileExists(join(projectRoot, "Cargo.toml"))) {
    skeletonJobs.push({
      name: "rust-skeletons",
      fn: () => extractRustSkeletons(projectRoot),
    });
  }

  // Java
  if (hasLanguage(languages, "Java")) {
    skeletonJobs.push({
      name: "java-skeletons",
      fn: () => extractJavaSkeletons(projectRoot),
    });
  }

  // Python
  if (await commandAvailable("python3")) {
    skeletonJobs.push({
      name: "python-skeletons",
      fn: () => extractPythonSkeletons(projectRoot),
    });
  }

  // Run skeleton extractors in parallel
  const skeletonResults = await Promise.allSettled(
    skeletonJobs.map(async (job) => {
      await job.fn();
      return job.name;
    }),
  );

  for (let i = 0; i < skeletonResults.length; i++) {
    const result = skeletonResults[i];
    if (result.status === "fulfilled") {
      logSuccess();
    } else {
      logFailure(skeletonJobs[i].name, result.reason?.message ?? String(result.reason));
    }
  }

  // ------------------------------------------------------------------
  // Write failure log
  // ------------------------------------------------------------------
  if (failureCount === 0) {
    logLines.push("# No failures recorded.");
  }

  await writeFile(failLog, logLines.join("\n") + "\n");

  return { successCount, failureCount };
}

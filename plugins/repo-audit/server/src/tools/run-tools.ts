import { readFile, readdir, access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBashScript, runScript } from "../lib/subprocess.js";
import { updateState, persistState, addError, getState } from "../lib/state.js";

// ----- Prescan pattern definitions -----

interface PrescanPattern {
  name: string;
  pattern: string;
  glob: string;
  languages: string[]; // Only run if these languages detected; empty = always
}

const PRESCAN_PATTERNS: PrescanPattern[] = [
  // TypeScript/JavaScript
  { name: "any-usage", pattern: "\\bany\\b", glob: "*.{ts,tsx}", languages: ["typescript", "javascript"] },
  { name: "ts-ignore", pattern: "@ts-ignore|@ts-expect-error", glob: "*.{ts,tsx}", languages: ["typescript"] },
  { name: "console-log", pattern: "console\\.(log|debug|info)", glob: "*.{ts,tsx,js,jsx}", languages: ["typescript", "javascript"] },
  { name: "as-any", pattern: "as any", glob: "*.{ts,tsx}", languages: ["typescript"] },
  // Python
  { name: "eval-exec", pattern: "eval\\(|exec\\(", glob: "*.py", languages: ["python"] },
  { name: "bare-except", pattern: "except\\s*:", glob: "*.py", languages: ["python"] },
  { name: "import-star", pattern: "from .* import \\*", glob: "*.py", languages: ["python"] },
  { name: "mutable-defaults", pattern: "def .*=\\s*\\[\\]|def .*=\\s*\\{\\}", glob: "*.py", languages: ["python"] },
  { name: "pickle-load", pattern: "pickle\\.load", glob: "*.py", languages: ["python"] },
  { name: "subprocess-shell", pattern: "subprocess.*shell\\s*=\\s*True", glob: "*.py", languages: ["python"] },
  { name: "unsafe-yaml", pattern: "yaml\\.load\\(", glob: "*.py", languages: ["python"] },
  // Go
  { name: "fmt-print", pattern: "fmt\\.Print", glob: "*.go", languages: ["go"] },
  // All languages
  { name: "hardcoded-secrets", pattern: "(?i)(password|api_key|secret|token)\\s*=\\s*[\"']", glob: "*", languages: [] },
  { name: "todo-fixme", pattern: "TODO|FIXME|HACK|XXX", glob: "*", languages: [] },
];

// ----- Interfaces -----

interface RunToolsInput {
  tools?: string[];
  skipIfCached?: boolean;
}

interface LinterResult {
  tool: string;
  issueCount: number;
}

interface TypeCheckResult {
  tool: string;
  errorCount: number;
}

interface DepAuditResult {
  tool: string;
  vulnCount: number;
}

interface SkeletonResult {
  language: string;
  fileCount: number;
}

interface PrescanResult {
  name: string;
  matchCount: number;
  fileCount: number;
}

interface RunToolsResult {
  metricsCollected: boolean;
  gitAnalysis: boolean;
  lintersRun: LinterResult[];
  typeCheckersRun: TypeCheckResult[];
  depAuditsRun: DepAuditResult[];
  prescanMatches: number;
  prescanResults: PrescanResult[];
  skeletonsExtracted: SkeletonResult[];
  failureCount: number;
  successCount: number;
}

// ----- Helper functions -----

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countJsonArrayItems(filePath: string): Promise<number> {
  try {
    const data = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed.length;
    // ESLint format: array of {messages: [...]}
    if (Array.isArray(parsed) === false && typeof parsed === "object") {
      // Try to count messages across all files
      let count = 0;
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value)) count += value.length;
      }
      return count || 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function countFileLines(filePath: string): Promise<number> {
  try {
    const data = await readFile(filePath, "utf-8");
    return data.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function parseLinterResults(
  toolOutputDir: string,
): Promise<LinterResult[]> {
  const linterDir = join(toolOutputDir, "linter-results");
  const results: LinterResult[] = [];

  try {
    const files = await readdir(linterDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const tool = file.replace(".json", "");
      const filePath = join(linterDir, file);

      try {
        const data = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(data);
        let issueCount = 0;

        if (Array.isArray(parsed)) {
          // ESLint format: [{filePath, messages: [...]}]
          for (const entry of parsed) {
            if (entry.messages && Array.isArray(entry.messages)) {
              issueCount += entry.messages.length;
            }
          }
        } else if (parsed && typeof parsed === "object") {
          // Ruff/generic format
          if (Array.isArray(parsed)) {
            issueCount = parsed.length;
          }
        }

        results.push({ tool, issueCount });
      } catch {
        // File exists but isn't valid JSON — still count it as run
        results.push({ tool, issueCount: 0 });
      }
    }
  } catch {
    // No linter results directory
  }

  return results;
}

async function parseTypeCheckResults(
  toolOutputDir: string,
): Promise<TypeCheckResult[]> {
  const typecheckDir = join(toolOutputDir, "typecheck");
  const results: TypeCheckResult[] = [];

  try {
    const files = await readdir(typecheckDir);
    for (const file of files) {
      const tool = file.replace(/\.(txt|json)$/, "");
      const filePath = join(typecheckDir, file);
      const errorCount = await countFileLines(filePath);
      results.push({ tool, errorCount });
    }
  } catch {
    // No typecheck directory
  }

  return results;
}

async function parseDepAuditResults(
  toolOutputDir: string,
): Promise<DepAuditResult[]> {
  const depsDir = join(toolOutputDir, "deps");
  const results: DepAuditResult[] = [];

  try {
    const files = await readdir(depsDir);
    for (const file of files) {
      const tool = file.replace(/\.(json|txt)$/, "");
      const filePath = join(depsDir, file);

      let vulnCount = 0;
      try {
        const data = await readFile(filePath, "utf-8");
        if (file.endsWith(".json")) {
          const parsed = JSON.parse(data);
          // npm audit format
          if (parsed.metadata?.vulnerabilities) {
            const v = parsed.metadata.vulnerabilities;
            vulnCount =
              (v.critical ?? 0) +
              (v.high ?? 0) +
              (v.moderate ?? 0) +
              (v.low ?? 0);
          }
          // pip-audit format
          else if (Array.isArray(parsed)) {
            vulnCount = parsed.length;
          }
          // cargo-audit format
          else if (parsed.vulnerabilities?.found) {
            vulnCount = parsed.vulnerabilities.found;
          }
        } else {
          // Text format — count non-empty lines as a rough proxy
          vulnCount = data
            .split("\n")
            .filter((l) => l.trim().length > 0 && !l.startsWith("#")).length;
        }
      } catch {
        // Malformed output
      }

      results.push({ tool, vulnCount });
    }
  } catch {
    // No deps directory
  }

  return results;
}

async function parseSkeletonResults(
  dataDir: string,
): Promise<SkeletonResult[]> {
  const skeletonDir = join(dataDir, "skeletons");
  const results: SkeletonResult[] = [];

  try {
    const files = await readdir(skeletonDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const language = file.replace(".json", "");
      const filePath = join(skeletonDir, file);

      try {
        const data = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(data);
        // Count entries — usually an object with file paths as keys
        const fileCount = typeof parsed === "object" && parsed !== null
          ? Object.keys(parsed).length
          : 0;
        results.push({ language, fileCount });
      } catch {
        results.push({ language, fileCount: 0 });
      }
    }
  } catch {
    // No skeletons directory
  }

  return results;
}

// ----- Prescan implementation -----

async function runPrescan(
  projectRoot: string,
  auditDir: string,
  detectedLanguages: string[],
): Promise<{ results: PrescanResult[]; totalMatches: number }> {
  const prescanDir = join(auditDir, "prescan");
  await mkdir(prescanDir, { recursive: true });

  const results: PrescanResult[] = [];
  let totalMatches = 0;
  const summaryLines: string[] = [];

  const langSet = new Set(detectedLanguages.map((l) => l.toLowerCase()));

  for (const pattern of PRESCAN_PATTERNS) {
    // Check if this pattern applies to detected languages
    if (
      pattern.languages.length > 0 &&
      !pattern.languages.some((l) => langSet.has(l))
    ) {
      continue;
    }

    try {
      // Use rg (ripgrep) if available, fall back to grep
      const rgArgs = [
        "--count-matches",
        "--glob",
        pattern.glob,
        "--glob",
        "!node_modules/**",
        "--glob",
        "!.git/**",
        "--glob",
        "!vendor/**",
        "--glob",
        "!dist/**",
        "--glob",
        "!build/**",
        "--glob",
        "!.venv/**",
        "--glob",
        "!target/**",
        "--glob",
        "!sdlc-audit/**",
        pattern.pattern,
        projectRoot,
      ];

      const result = await runScript("rg", rgArgs, {
        cwd: projectRoot,
        timeout: 15_000,
      });

      if (result.stdout.trim()) {
        const lines = result.stdout.trim().split("\n");
        let matchCount = 0;
        for (const line of lines) {
          const parts = line.split(":");
          const count = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(count)) matchCount += count;
        }
        const fileCount = lines.length;

        results.push({ name: pattern.name, matchCount, fileCount });
        totalMatches += matchCount;
        summaryLines.push(
          `  ${pattern.name}: ${matchCount} instances across ${fileCount} files`,
        );
      } else {
        results.push({ name: pattern.name, matchCount: 0, fileCount: 0 });
        summaryLines.push(`  ${pattern.name}: 0 instances`);
      }
    } catch {
      // rg not available or pattern error — try grep as fallback
      try {
        const grepResult = await runScript(
          "grep",
          ["-rEc", pattern.pattern, projectRoot, "--include", pattern.glob],
          { cwd: projectRoot, timeout: 15_000 },
        );

        if (grepResult.stdout.trim()) {
          const lines = grepResult.stdout.trim().split("\n");
          const matchCount = lines.length;
          results.push({ name: pattern.name, matchCount, fileCount: matchCount });
          totalMatches += matchCount;
          summaryLines.push(
            `  ${pattern.name}: ${matchCount} instances`,
          );
        }
      } catch {
        // Neither rg nor grep worked for this pattern
        results.push({ name: pattern.name, matchCount: 0, fileCount: 0 });
      }
    }
  }

  // Write prescan summary
  const summary = summaryLines.length > 0
    ? `Pattern Pre-Scan Results\n${"=".repeat(40)}\n${summaryLines.join("\n")}\n\nTotal matches: ${totalMatches}\n`
    : "Pattern Pre-Scan Results\n" + "=".repeat(40) + "\nNo patterns matched.\n";

  await writeFile(join(prescanDir, "prescan-summary.txt"), summary);

  return { results, totalMatches };
}

// ----- Parse the failure log -----

async function parseFailureLog(
  dataDir: string,
): Promise<{ successCount: number; failureCount: number }> {
  try {
    const logPath = join(dataDir, "pre-analysis-failures.log");
    const data = await readFile(logPath, "utf-8");
    const failures = data
      .split("\n")
      .filter((l) => l.startsWith("[")).length;
    // The script prints "Succeeded: X | Failed: Y" — parse that from stdout if available
    // Fallback to counting failure entries
    return {
      successCount: 0, // We'll calculate this differently
      failureCount: failures,
    };
  } catch {
    return { successCount: 0, failureCount: 0 };
  }
}

// ----- Main tool function -----

export async function runTools(
  input: RunToolsInput,
  pluginRoot: string,
): Promise<RunToolsResult> {
  const state = getState();
  if (!state) {
    throw new Error(
      "State not initialized. Call audit_discover first.",
    );
  }

  const projectRoot = state.projectRoot;
  const auditDir = state.auditDir;
  const dataDir = join(auditDir, "data");
  const toolOutputDir = join(auditDir, "tool-output");

  updateState({ phase: "pre-analysis" });

  const skipIfCached = input.skipIfCached ?? true;

  // Check if pre-analysis already ran (metrics.json exists)
  if (skipIfCached && (await fileExists(join(dataDir, "metrics.json")))) {
    // Parse existing results instead of re-running
    const lintersRun = await parseLinterResults(toolOutputDir);
    const typeCheckersRun = await parseTypeCheckResults(toolOutputDir);
    const depAuditsRun = await parseDepAuditResults(toolOutputDir);
    const skeletonsExtracted = await parseSkeletonResults(dataDir);
    const prescanExists = await fileExists(
      join(auditDir, "prescan", "prescan-summary.txt"),
    );

    await persistState();

    return {
      metricsCollected: true,
      gitAnalysis: await fileExists(join(dataDir, "git-hotspots.txt")),
      lintersRun,
      typeCheckersRun,
      depAuditsRun,
      prescanMatches: 0,
      prescanResults: [],
      skeletonsExtracted,
      failureCount: 0,
      successCount: lintersRun.length + typeCheckersRun.length + depAuditsRun.length,
    };
  }

  // Run the main pre-analysis script
  try {
    const scriptPath = join(pluginRoot, "scripts", "run-pre-analysis-tools.sh");
    const result = await runBashScript(scriptPath, [projectRoot], {
      cwd: projectRoot,
      timeout: 300_000, // 5 minutes for all tools
    });

    // Parse success/failure counts from stdout
    const summaryMatch = result.stdout.match(
      /Succeeded:\s*(\d+)\s*\|\s*Failed:\s*(\d+)/,
    );

    if (!summaryMatch) {
      // Fallback: parse the failure log
      const logResult = await parseFailureLog(dataDir);
    }
  } catch (err) {
    addError(
      "audit_run_tools",
      `run-pre-analysis-tools.sh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Run the prescan (grep-based pattern matching)
  const detection = state.detection as Record<string, unknown> | null;
  const detectedLanguages = (
    (detection?.["primary_languages"] as string[]) ??
    (detection?.["languages"] as string[]) ??
    []
  );
  let prescanResults: PrescanResult[] = [];
  let prescanMatches = 0;

  try {
    const prescan = await runPrescan(projectRoot, auditDir, detectedLanguages);
    prescanResults = prescan.results;
    prescanMatches = prescan.totalMatches;
  } catch (err) {
    addError(
      "audit_run_tools",
      `Prescan failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse all results
  const metricsCollected = await fileExists(join(dataDir, "metrics.json"));
  const gitAnalysis = await fileExists(join(dataDir, "git-hotspots.txt"));
  const lintersRun = await parseLinterResults(toolOutputDir);
  const typeCheckersRun = await parseTypeCheckResults(toolOutputDir);
  const depAuditsRun = await parseDepAuditResults(toolOutputDir);
  const skeletonsExtracted = await parseSkeletonResults(dataDir);
  const { failureCount } = await parseFailureLog(dataDir);

  const successCount =
    (metricsCollected ? 1 : 0) +
    (gitAnalysis ? 1 : 0) +
    lintersRun.length +
    typeCheckersRun.length +
    depAuditsRun.length +
    skeletonsExtracted.length;

  await persistState();

  return {
    metricsCollected,
    gitAnalysis,
    lintersRun,
    typeCheckersRun,
    depAuditsRun,
    prescanMatches,
    prescanResults,
    skeletonsExtracted,
    failureCount,
    successCount,
  };
}

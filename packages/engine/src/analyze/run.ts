/**
 * Deterministic analysis pass: project linters, type checkers, secret scan,
 * dependency advisories and graph structure — all recorded as findings.
 */

import { getDb } from "../db/db.js";
import { closeStale, recordFindings, recordToolRun } from "../findings/record.js";
import { extractSnippet } from "../findings/fingerprint.js";
import type { FindingInput } from "../findings/types.js";
import { collectGit } from "../scan/git.js";
import { startRun } from "../scan/scan.js";
import { readSourceFiles } from "../scan/source.js";
import { auditDependencies } from "./deps.js";
import { analyzeGraph } from "./graph.js";
import { scanSecrets } from "./secrets.js";
import { scanSupplyChain } from "./supply-chain.js";
import { runProjectTools, type AnalyzerOutcome } from "./tools.js";
import { scanUnicode } from "./unicode.js";

export interface RunAnalyzersOptions {
  /** Skip the network call to the OSV advisory database. */
  offline?: boolean;
  /** Stop project subprocesses and network work when the caller cancels. */
  signal?: AbortSignal;
}

export interface RunAnalyzersResult {
  runId: number;
  tools: Array<{ tool: string; status: string; detail: string; findings: number }>;
  created: number;
  updated: number;
  reopened: number;
  suppressed: number;
  closed: number;
  openBySeverity: Record<string, number>;
}

/** Rule prefixes a tool owns, used to retire findings it no longer reports. */
const TOOL_PREFIXES: Record<string, string> = {
  eslint: "eslint/",
  tsc: "tsc/",
  ruff: "ruff/",
  mypy: "mypy/",
  secrets: "secrets/",
  deps: "deps/",
  graph: "graph/",
  "supply-chain": "supply-chain/",
  unicode: "unicode/",
};

/**
 * Rules that a test file legitimately trips on purpose.
 *
 * A scanner's own fixtures contain fake AWS keys and eval'd strings because
 * that is what they are testing, and a security suite in any repository does
 * the same. Reported at full severity they crowd out real problems — six of
 * twelve findings on this very repository were its own fixtures.
 *
 * They are demoted rather than dropped: a real secret committed to a test file
 * is still a leaked secret, so it stays visible, just not at the top.
 */
const FIXTURE_PRONE = /^(secrets\/|supply-chain\/obfuscated-payload|unicode\/)/;

function demoteFixtures(findings: FindingInput[], testPaths: Set<string>): FindingInput[] {
  return findings.map((finding) => {
    if (!finding.path || !testPaths.has(finding.path)) return finding;
    if (!FIXTURE_PRONE.test(finding.ruleId)) return finding;
    return {
      ...finding,
      severity: "low",
      confidence: "low",
      description:
        `${finding.description ?? ""}`.trim() +
        (finding.description ? " " : "") +
        "Found in a test file, where this is usually a deliberate fixture. Confirm before treating it as real.",
    };
  });
}

export async function runAnalyzers(
  projectRoot: string,
  options: RunAnalyzersOptions = {},
): Promise<RunAnalyzersResult> {
  options.signal?.throwIfAborted();
  const db = await getDb(projectRoot);
  const git = await collectGit(projectRoot, "6 months ago", options.signal);

  const files = await readSourceFiles(projectRoot);
  options.signal?.throwIfAborted();
  const contents = new Map(files.map((file) => [file.path, file.content]));

  const outcomes: AnalyzerOutcome[] = [
    ...(await runProjectTools(projectRoot, options.signal)),
  ];
  const testPaths = new Set(files.filter((file) => file.isTest).map((file) => file.path));

  const secretFindings = demoteFixtures(scanSecrets(files), testPaths);
  outcomes.push({
    tool: "secrets",
    status: "ok",
    detail: `${secretFindings.length} candidates`,
    findings: secretFindings,
  });

  const supplyChainFindings = demoteFixtures(
    await scanSupplyChain(projectRoot, files),
    testPaths,
  );
  options.signal?.throwIfAborted();
  outcomes.push({
    tool: "supply-chain",
    status: "ok",
    detail: `${supplyChainFindings.length} findings across install scripts, workflows and agent config`,
    findings: supplyChainFindings,
  });

  const unicodeFindings = scanUnicode(files);
  outcomes.push({
    tool: "unicode",
    status: "ok",
    detail: `${unicodeFindings.length} smuggling candidates`,
    findings: unicodeFindings,
  });

  outcomes.push(
    options.offline
      ? { tool: "deps", status: "skipped", detail: "offline mode", findings: [] }
      : await auditDependencies(projectRoot, options.signal),
  );

  const graphFindings = analyzeGraph(db);
  outcomes.push({
    tool: "graph",
    status: "ok",
    detail: `${graphFindings.length} structural findings`,
    findings: graphFindings,
  });

  // Attach the code each finding points at so fingerprints survive line moves.
  const withSnippets = (findings: FindingInput[]): FindingInput[] =>
    findings.map((finding) => {
      if (finding.snippet || !finding.path) return finding;
      const content = contents.get(finding.path);
      if (!content) return finding;
      return {
        ...finding,
        snippet: extractSnippet(content, finding.lineStart, finding.lineEnd),
      };
    });

  let created = 0;
  let updated = 0;
  let reopened = 0;
  let suppressed = 0;
  let closed = 0;

  options.signal?.throwIfAborted();
  // Do not create a visible run until all cancellable work has completed. A
  // removed workspace closes and flushes its handle, so inserting this before
  // the subprocesses would persist a misleading unfinished run on cancel.
  const runId = await startRun(db, "tools", git.sha);
  db.transaction(() => {
    for (const outcome of outcomes) {
      const summary = recordFindings(db, runId, withSnippets(outcome.findings));
      created += summary.created;
      updated += summary.updated;
      reopened += summary.reopened;
      suppressed += summary.suppressed;

      recordToolRun(
        db,
        runId,
        outcome.tool,
        outcome.status,
        outcome.detail,
        outcome.findings.length,
      );

      const prefix = TOOL_PREFIXES[outcome.tool];
      if (prefix && outcome.status === "ok") {
        closed += closeStale(db, runId, prefix);
      }
    }
  });

  db.run("UPDATE runs SET finished_at = ? WHERE id = ?", [new Date().toISOString(), runId]);
  await db.flush();

  const openBySeverity: Record<string, number> = {};
  for (const row of db.all<{ severity: string; n: number }>(
    "SELECT severity, COUNT(*) AS n FROM findings WHERE status IN ('open','regressed') GROUP BY severity",
  )) {
    openBySeverity[row.severity] = row.n;
  }

  return {
    runId,
    tools: outcomes.map((outcome) => ({
      tool: outcome.tool,
      status: outcome.status,
      detail: outcome.detail,
      findings: outcome.findings.length,
    })),
    created,
    updated,
    reopened,
    suppressed,
    closed,
    openBySeverity,
  };
}

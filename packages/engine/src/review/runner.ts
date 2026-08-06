/**
 * Model review, run by the engine.
 *
 * Two passes, and the second one matters more than the first. A single review
 * pass produces plausible findings, and plausible is not the same as real —
 * so every proposed finding is handed to a fresh call that is asked to refute
 * it, and anything that cannot be substantiated against the actual code is
 * dropped before it ever reaches the store.
 *
 * This is deliberately expensive and explicitly user-initiated. It spends the
 * user's own CLI quota.
 */

import { createHash } from "node:crypto";
import { contentDir } from "../content.js";
import type { Db } from "../db/db.js";
import { extractSnippet } from "../findings/fingerprint.js";
import { recordFindings } from "../findings/record.js";
import {
  CATEGORIES,
  CONFIDENCES,
  SEVERITIES,
  type FindingInput,
} from "../findings/types.js";
import { buildContext } from "../plan/context.js";
import { loadPlan, type WorkUnit } from "../plan/risk.js";
import { readWorkspaceText } from "../lib/workspace-path.js";
import { extractJson, runClaude } from "./agent.js";

export interface ReviewOptions {
  /** Review only these units. Defaults to the whole saved plan. */
  unitIds?: string[];
  /** Cap on units, so a first run cannot cost more than expected. */
  maxUnits?: number;
  lens?: "security" | "correctness" | "testing" | "performance";
  /** Second-pass refutation. On by default; off roughly halves cost. */
  verify?: boolean;
  model?: string;
  onProgress?: (message: string) => void;
  /** Abort all current and future model calls for this review. */
  signal?: AbortSignal;
  /** Injectable paid-agent boundary for deterministic engine tests. */
  runAgent?: typeof runClaude;
}

export interface ReviewSummary {
  units: number;
  proposed: number;
  confirmed: number;
  rejected: number;
  recorded: { created: number; updated: number; reopened: number; suppressed: number };
  costUsd: number;
  durationMs: number;
  failures: Array<{ unitId: string; error: string }>;
}

export interface ProposedFinding {
  ruleId?: string;
  category?: string;
  severity?: string;
  confidence?: string;
  title?: string;
  description?: string;
  suggestion?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
  evidence?: string;
}

/** Hard ceiling on model-controlled verification work for one review unit. */
export const MAX_PROPOSALS_PER_UNIT = 20;

const REVIEW_INSTRUCTION = `
Return ONLY a JSON array of findings. No prose before or after it.

Each element:
{
  "ruleId": "llm/<short-slug>",
  "category": one of ${JSON.stringify(CATEGORIES)},
  "severity": one of ${JSON.stringify(SEVERITIES)},
  "confidence": one of ${JSON.stringify(CONFIDENCES)},
  "title": "one line, specific",
  "description": "what is wrong and why it matters",
  "suggestion": "what to change",
  "path": "path exactly as given above",
  "lineStart": <number>,
  "lineEnd": <number>,
  "symbol": "enclosing function or class if known",
  "evidence": "the exact line(s) from the source that show this"
}

Rules:
- Only report what is visible in the code above. Do not speculate about code you were not shown.
- Every finding needs a path and lineStart that exist in the code above.
- Prefer fewer, certain findings over many uncertain ones.
- If nothing is wrong, return [].
`;

export interface SourceSlice {
  text: string;
  firstLine: number;
  lastLine: number;
  contentSha: string;
}

interface VerificationItem {
  index: number;
  finding: ProposedFinding;
  source: SourceSlice;
}

interface VerificationVerdict {
  index?: number;
  substantiated?: boolean;
  correctedLine?: number | null;
}

function verificationVerdicts(
  parsed: unknown,
  candidates: VerificationItem[],
): Map<number, VerificationVerdict> | null {
  if (!Array.isArray(parsed) || parsed.length !== candidates.length) return null;

  const expected = new Map(candidates.map((candidate) => [candidate.index, candidate.source]));
  const verdicts = new Map<number, VerificationVerdict>();
  for (const value of parsed) {
    if (value === null || typeof value !== "object") return null;
    const verdict = value as VerificationVerdict;
    if (
      !Number.isInteger(verdict.index) ||
      !expected.has(verdict.index as number) ||
      verdicts.has(verdict.index as number) ||
      typeof verdict.substantiated !== "boolean"
    ) {
      return null;
    }
    const source = expected.get(verdict.index as number) as SourceSlice;
    if (
      verdict.correctedLine !== null &&
      verdict.correctedLine !== undefined &&
      (!Number.isInteger(verdict.correctedLine) ||
        verdict.correctedLine < source.firstLine ||
        verdict.correctedLine > source.lastLine)
    ) {
      return null;
    }
    verdicts.set(verdict.index as number, verdict);
  }
  return verdicts;
}

/** Model JSON is untrusted: only the boolean literal true confirms a claim. */
export function isSubstantiatedVerdict(
  verdict: unknown,
): verdict is VerificationVerdict & { substantiated: true } {
  return (
    verdict !== null &&
    typeof verdict === "object" &&
    (verdict as VerificationVerdict).substantiated === true
  );
}

function verificationPrompt(items: VerificationItem[]): string {
  const claims = items.map(({ index, finding, source }) => ({
    index,
    claim: finding,
    source: source.text,
  }));
  return `You are checking whether code review findings are real. Default to rejecting them.

For each indexed claim below, decide whether it is substantiated by its source. Reject it if
the cited lines do not show the claim, the concern is already handled, it is only a style
preference, or it depends on code outside the supplied source.

CLAIMS
${JSON.stringify(claims, null, 2)}

Return ONLY a JSON array with exactly one object per claim:
[{"index": 0, "substantiated": true|false, "reason": "<one sentence>", "correctedLine": <number or null>}]

A correctedLine must be one of the numbered source lines supplied for that claim.`;
}

/** Read the numbered slice of a file the finding points at, plus surrounding context. */
function sourceSha(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 20);
}

export async function sourceFor(
  projectRoot: string,
  path: string,
  lineStart?: number,
  lineEnd?: number,
): Promise<SourceSlice> {
  const content = await readWorkspaceText(projectRoot, path);
  const lines = content.split("\n");
  if (!lineStart || lineStart > lines.length) {
    throw new Error(`Cited line ${lineStart ?? "missing"} is outside ${path}.`);
  }
  if (lineEnd && lineEnd > lines.length) {
    throw new Error(`Cited end line ${lineEnd} is outside ${path}.`);
  }
  const from = Math.max(0, lineStart - 15);
  const to = Math.min(lines.length, (lineEnd ?? lineStart) + 15);
  return {
    firstLine: from + 1,
    lastLine: to,
    contentSha: sourceSha(content),
    text: lines
      .slice(from, to)
      .map((line, index) => `${String(from + index + 1).padStart(5)}  ${line}`)
      .join("\n"),
  };
}

function valid(finding: ProposedFinding): boolean {
  return Boolean(
    finding.title &&
      finding.path &&
      finding.ruleId &&
      Number.isFinite(finding.lineStart) &&
      Number.isInteger(finding.lineStart) &&
      (finding.lineStart as number) > 0 &&
      (finding.lineEnd === undefined ||
        (Number.isFinite(finding.lineEnd) &&
          Number.isInteger(finding.lineEnd) &&
          (finding.lineEnd as number) >= (finding.lineStart as number))) &&
      CATEGORIES.includes(finding.category as (typeof CATEGORIES)[number]) &&
      SEVERITIES.includes(finding.severity as (typeof SEVERITIES)[number]) &&
      CONFIDENCES.includes(finding.confidence as (typeof CONFIDENCES)[number]),
  );
}

/** Validate, deduplicate, and cap untrusted first-pass model output. */
export function selectReviewProposals(parsed: unknown): ProposedFinding[] {
  if (!Array.isArray(parsed)) return [];
  const selected: ProposedFinding[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const finding = candidate as ProposedFinding;
    if (!valid(finding)) continue;
    const key = JSON.stringify([
      finding.ruleId,
      finding.path,
      finding.lineStart,
      finding.lineEnd ?? null,
      finding.title,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(finding);
    if (selected.length === MAX_PROPOSALS_PER_UNIT) break;
  }
  return selected;
}

/** A headless review has no Read tool, so omitted source makes the unit unreviewable. */
export function reviewContextFailure(filesOmitted: string[]): string | null {
  if (filesOmitted.length === 0) return null;
  return `Review context omitted source files: ${filesOmitted.join(", ")}`;
}

export async function runReview(
  db: Db,
  projectRoot: string,
  options: ReviewOptions = {},
): Promise<ReviewSummary> {
  const started = Date.now();
  const note = options.onProgress ?? ((): void => {});
  const verify = options.verify !== false;
  const runAgent = options.runAgent ?? runClaude;
  options.signal?.throwIfAborted();

  if (
    options.maxUnits !== undefined &&
    (!Number.isInteger(options.maxUnits) || options.maxUnits <= 0)
  ) {
    throw new Error("maxUnits must be a positive integer.");
  }

  const plan = loadPlan(db);
  if (plan.length === 0) {
    throw new Error("No plan found. Run audit_plan first.");
  }

  let units: WorkUnit[] = options.unitIds
    ? plan.filter((unit) => options.unitIds?.includes(unit.id))
    : plan;
  if (options.maxUnits !== undefined) units = units.slice(0, options.maxUnits);
  if (units.length === 0) throw new Error("No matching review units.");

  const summary: ReviewSummary = {
    units: units.length,
    proposed: 0,
    confirmed: 0,
    rejected: 0,
    recorded: { created: 0, updated: 0, reopened: 0, suppressed: 0 },
    costUsd: 0,
    durationMs: 0,
    failures: [],
  };

  const runId = db.get<{ id: number }>("SELECT id FROM runs ORDER BY id DESC LIMIT 1")?.id ?? 0;
  const now = (): string => new Date().toISOString();

  for (const unit of units) {
    options.signal?.throwIfAborted();
    note(`reviewing ${unit.id}`);
    const unitStarted = Date.now();

    const context = await buildContext(db, unit, {
      projectRoot,
      pluginRoot: contentDir(),
      // REVIEW_INSTRUCTION below is the only reporting channel: the MCP
      // instructions would let the model bypass the verification pass.
      instructions: false,
      ...(options.lens ? { lens: options.lens } : {}),
    });

    const contextError = reviewContextFailure(context.filesOmitted);
    if (contextError) {
      summary.failures.push({ unitId: unit.id, error: contextError });
      db.run(
        `INSERT INTO review_runs(run_id, unit_id, agent, status, detail, proposed, confirmed, cost_usd, duration_ms, created_at)
         VALUES(?, ?, 'claude', 'failed', ?, 0, 0, 0, ?, ?)`,
        [runId, unit.id, contextError, Date.now() - unitStarted, now()],
      );
      note(`  incomplete: ${contextError}`);
      continue;
    }

    const result = await runAgent(`${context.prompt}\n\n${REVIEW_INSTRUCTION}`, {
      cwd: projectRoot,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
    options.signal?.throwIfAborted();
    let unitCost = result.costUsd ?? 0;
    summary.costUsd += result.costUsd ?? 0;

    if (!result.ok) {
      summary.failures.push({ unitId: unit.id, error: result.error ?? "unknown" });
      db.run(
        `INSERT INTO review_runs(run_id, unit_id, agent, status, detail, proposed, confirmed, cost_usd, duration_ms, created_at)
         VALUES(?, ?, 'claude', 'failed', ?, 0, 0, ?, ?, ?)`,
        [runId, unit.id, result.error ?? "", result.costUsd ?? 0, result.durationMs, now()],
      );
      note(`  failed: ${result.error}`);
      continue;
    }

    const parsed = extractJson<ProposedFinding[]>(result.text);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => value !== null && typeof value === "object" && valid(value))
    ) {
      const error = "Review returned malformed findings JSON.";
      summary.failures.push({ unitId: unit.id, error });
      db.run(
        `INSERT INTO review_runs(run_id, unit_id, agent, status, detail, proposed, confirmed, cost_usd, duration_ms, created_at)
         VALUES(?, ?, 'claude', 'failed', ?, 0, 0, ?, ?, ?)`,
        [runId, unit.id, error, unitCost, Date.now() - unitStarted, now()],
      );
      note(`  failed: ${error}`);
      continue;
    }
    const proposals = selectReviewProposals(parsed);
    summary.proposed += proposals.length;
    note(`  proposed ${proposals.length}`);

    // --- verification --------------------------------------------------
    const candidates: VerificationItem[] = [];
    for (const [index, proposal] of proposals.entries()) {
      try {
        candidates.push({
          index,
          finding: proposal,
          source: await sourceFor(
            projectRoot,
            proposal.path as string,
            proposal.lineStart,
            proposal.lineEnd,
          ),
        });
      } catch {
        // A finding pointing at a file we cannot read is not a finding.
        summary.rejected++;
      }
    }

    let verdicts = new Map<number, VerificationVerdict>();
    if (verify && candidates.length > 0) {
      const check = await runAgent(verificationPrompt(candidates), {
        cwd: projectRoot,
        timeoutMs: 120_000,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      options.signal?.throwIfAborted();
      unitCost += check.costUsd ?? 0;
      summary.costUsd += check.costUsd ?? 0;

      const parsedVerdicts = check.ok ? extractJson<VerificationVerdict[]>(check.text) : null;
      const checkedVerdicts = verificationVerdicts(parsedVerdicts, candidates);
      if (!check.ok || !checkedVerdicts) {
        const error = check.ok
          ? "Verification returned malformed verdict JSON."
          : `Verification failed: ${check.error ?? "unknown"}`;
        summary.failures.push({ unitId: unit.id, error });
        db.run(
          `INSERT INTO review_runs(run_id, unit_id, agent, status, detail, proposed, confirmed, cost_usd, duration_ms, created_at)
           VALUES(?, ?, 'claude', 'failed', ?, ?, 0, ?, ?, ?)`,
          [
            runId,
            unit.id,
            error,
            proposals.length,
            unitCost,
            Date.now() - unitStarted,
            now(),
          ],
        );
        note(`  failed: ${error}`);
        continue;
      }
      verdicts = checkedVerdicts;
    }

    const confirmed: FindingInput[] = [];
    for (const candidate of candidates) {
      const proposal = candidate.finding;
      if (verify) {
        const verdict = verdicts.get(candidate.index);
        // Missing, malformed, or failed verification is unsubstantiated.
        if (!isSubstantiatedVerdict(verdict)) {
          summary.rejected++;
          continue;
        }
        if (verdict.correctedLine !== null && verdict.correctedLine !== undefined) {
          proposal.lineStart = verdict.correctedLine;
          if (proposal.lineEnd && proposal.lineEnd < verdict.correctedLine) {
            delete proposal.lineEnd;
          }
        }
      }

      let snippet: string | undefined;
      try {
        const content = await readWorkspaceText(projectRoot, proposal.path as string);
        // Verification reasoned about candidate.source. If the file moved
        // while that model call was running, neither its verdict nor its line
        // correction applies to the current workspace.
        if (sourceSha(content) !== candidate.source.contentSha) {
          summary.rejected++;
          continue;
        }
        snippet = extractSnippet(content, proposal.lineStart ?? 1, proposal.lineEnd);
      } catch {
        // Deleted, unreadable, or escaped since verification is also a source
        // generation change. Never record a verdict against code we cannot
        // prove is still the code it reviewed.
        summary.rejected++;
        continue;
      }

      confirmed.push({
        ruleId: proposal.ruleId as string,
        category: proposal.category as FindingInput["category"],
        severity: proposal.severity as FindingInput["severity"],
        confidence: proposal.confidence as FindingInput["confidence"],
        title: proposal.title as string,
        ...(proposal.description ? { description: proposal.description } : {}),
        ...(proposal.suggestion ? { suggestion: proposal.suggestion } : {}),
        path: proposal.path as string,
        ...(proposal.lineStart ? { lineStart: proposal.lineStart } : {}),
        ...(proposal.lineEnd ? { lineEnd: proposal.lineEnd } : {}),
        ...(proposal.symbol ? { symbol: proposal.symbol } : {}),
        source: "llm",
        ...(snippet ? { snippet } : {}),
      });
    }

    summary.confirmed += confirmed.length;
    if (confirmed.length > 0) {
      const recorded = recordFindings(db, runId, confirmed);
      summary.recorded.created += recorded.created;
      summary.recorded.updated += recorded.updated;
      summary.recorded.reopened += recorded.reopened;
      summary.recorded.suppressed += recorded.suppressed;
    }

    db.run(
      `INSERT INTO review_runs(run_id, unit_id, agent, status, detail, proposed, confirmed, cost_usd, duration_ms, created_at)
       VALUES(?, ?, 'claude', 'ok', ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        unit.id,
        verify ? "verified" : "unverified",
        proposals.length,
        confirmed.length,
        // This unit's own spend — the running total here made a later
        // SUM(cost_usd) over-report quadratically.
        unitCost,
        Date.now() - unitStarted,
        now(),
      ],
    );

    note(`  confirmed ${confirmed.length} of ${proposals.length}`);
    await db.flush();
  }

  summary.durationMs = Date.now() - started;
  await db.flush();
  return summary;
}

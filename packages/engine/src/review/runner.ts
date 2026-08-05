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

interface ProposedFinding {
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

function verificationPrompt(finding: ProposedFinding, source: string): string {
  return `You are checking whether a code review finding is real. Default to rejecting it.

CLAIM
  rule: ${finding.ruleId}
  severity: ${finding.severity}
  file: ${finding.path}:${finding.lineStart}
  title: ${finding.title}
  description: ${finding.description ?? ""}
  evidence offered: ${finding.evidence ?? "(none)"}

SOURCE
\`\`\`
${source}
\`\`\`

Decide whether the claim is substantiated by this source. Reject it if:
- the cited lines do not show what the claim says they show,
- the concern is already handled elsewhere in the source,
- it is a style preference rather than a defect,
- it depends on code you cannot see here.

Return ONLY:
{"substantiated": true|false, "reason": "<one sentence>", "correctedLine": <number or null>}`;
}

/** Read the numbered slice of a file the finding points at, plus surrounding context. */
async function sourceFor(
  projectRoot: string,
  path: string,
  lineStart?: number,
  lineEnd?: number,
): Promise<string> {
  const content = await readWorkspaceText(projectRoot, path);
  const lines = content.split("\n");
  const from = Math.max(0, (lineStart ?? 1) - 15);
  const to = Math.min(lines.length, (lineEnd ?? lineStart ?? 1) + 15);
  return lines
    .slice(from, to)
    .map((line, index) => `${String(from + index + 1).padStart(5)}  ${line}`)
    .join("\n");
}

function valid(finding: ProposedFinding): boolean {
  return Boolean(
    finding.title &&
      finding.path &&
      finding.ruleId &&
      CATEGORIES.includes(finding.category as (typeof CATEGORIES)[number]) &&
      SEVERITIES.includes(finding.severity as (typeof SEVERITIES)[number]) &&
      CONFIDENCES.includes(finding.confidence as (typeof CONFIDENCES)[number]),
  );
}

export async function runReview(
  db: Db,
  projectRoot: string,
  options: ReviewOptions = {},
): Promise<ReviewSummary> {
  const started = Date.now();
  const note = options.onProgress ?? ((): void => {});
  const verify = options.verify !== false;

  const plan = loadPlan(db);
  if (plan.length === 0) {
    throw new Error("No plan found. Run audit_plan first.");
  }

  let units: WorkUnit[] = options.unitIds
    ? plan.filter((unit) => options.unitIds?.includes(unit.id))
    : plan;
  if (options.maxUnits) units = units.slice(0, options.maxUnits);
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

    const result = await runClaude(`${context.prompt}\n\n${REVIEW_INSTRUCTION}`, {
      cwd: projectRoot,
      ...(options.model ? { model: options.model } : {}),
    });
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
    const proposals = (Array.isArray(parsed) ? parsed : []).filter(valid);
    summary.proposed += proposals.length;
    note(`  proposed ${proposals.length}`);

    // --- verification --------------------------------------------------
    const confirmed: FindingInput[] = [];
    for (const proposal of proposals) {
      let snippet: string | undefined;
      let source: string;
      try {
        source = await sourceFor(
          projectRoot,
          proposal.path as string,
          proposal.lineStart,
          proposal.lineEnd,
        );
      } catch {
        // A finding pointing at a file we cannot read is not a finding.
        summary.rejected++;
        continue;
      }

      if (verify) {
        const check = await runClaude(verificationPrompt(proposal, source), {
          cwd: projectRoot,
          timeoutMs: 120_000,
          ...(options.model ? { model: options.model } : {}),
        });
        unitCost += check.costUsd ?? 0;
        summary.costUsd += check.costUsd ?? 0;

        const verdict = check.ok
          ? extractJson<{ substantiated?: boolean; correctedLine?: number | null }>(check.text)
          : null;

        // Unverifiable is treated as unsubstantiated, on purpose.
        if (!verdict?.substantiated) {
          summary.rejected++;
          continue;
        }
        if (typeof verdict.correctedLine === "number") {
          proposal.lineStart = verdict.correctedLine;
        }
      }

      try {
        const content = await readWorkspaceText(projectRoot, proposal.path as string);
        snippet = extractSnippet(content, proposal.lineStart ?? 1, proposal.lineEnd);
      } catch {
        // Fingerprint falls back to the title.
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

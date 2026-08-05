/**
 * The write path for findings.
 *
 * Everything that produces a finding — linters, the secret scanner, sub-agents
 * — goes through here, so dedup, suppression and status transitions happen in
 * exactly one place.
 */

import type { Db } from "../db/db.js";
import { anchorSha, fingerprint } from "./fingerprint.js";
import type { FindingInput } from "./types.js";

export interface RecordSummary {
  created: number;
  updated: number;
  reopened: number;
  suppressed: number;
  ids: string[];
}

function isSuppressed(db: Db, id: string, ruleId: string, path: string | null): boolean {
  // Path-only rows (rule_id NULL) must match too — `rule_id = ?` is never
  // true against NULL, which made such suppressions silently inert forever.
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM suppressions
     WHERE finding_id = ?
        OR (rule_id = ? AND (path_prefix IS NULL OR ? LIKE path_prefix || '%'))
        OR (rule_id IS NULL AND path_prefix IS NOT NULL AND ? LIKE path_prefix || '%')`,
    [id, ruleId, path ?? "", path ?? ""],
  );
  return (row?.n ?? 0) > 0;
}

export function recordFindings(
  db: Db,
  runId: number,
  findings: FindingInput[],
): RecordSummary {
  const summary: RecordSummary = {
    created: 0,
    updated: 0,
    reopened: 0,
    suppressed: 0,
    ids: [],
  };

  for (const finding of findings) {
    const id = fingerprint(finding);
    const path = finding.path ?? null;

    if (isSuppressed(db, id, finding.ruleId, path)) {
      summary.suppressed++;
      continue;
    }

    const existing = db.get<{ status: string }>(
      "SELECT status FROM findings WHERE id = ?",
      [id],
    );

    if (!existing) {
      db.run(
        `INSERT INTO findings(id, rule_id, category, severity, confidence, source, path,
                              line_start, line_end, anchor_sha, title, description, suggestion,
                              status, first_seen_run, last_seen_run, occurrences)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`,
        [
          id,
          finding.ruleId,
          finding.category,
          finding.severity,
          finding.confidence,
          finding.source,
          path,
          finding.lineStart ?? null,
          finding.lineEnd ?? null,
          anchorSha(finding.snippet),
          finding.title.slice(0, 200),
          finding.description ?? "",
          finding.suggestion ?? null,
          runId,
          runId,
        ],
      );
      summary.created++;
      summary.ids.push(id);
      continue;
    }

    // Seen before: refresh position and severity, and reopen if it had been
    // marked fixed. Human decisions (accepted / false_positive) are sticky.
    const reopened = existing.status === "fixed";
    const nextStatus =
      existing.status === "accepted" || existing.status === "false_positive"
        ? existing.status
        : reopened
          ? "regressed"
          : "open";

    db.run(
      `UPDATE findings
         SET line_start = ?, line_end = ?, anchor_sha = ?, severity = ?, confidence = ?,
             title = ?, description = ?, suggestion = COALESCE(?, suggestion),
             status = ?, last_seen_run = ?, fixed_in_run = NULL,
             occurrences = occurrences + 1
       WHERE id = ?`,
      [
        finding.lineStart ?? null,
        finding.lineEnd ?? null,
        anchorSha(finding.snippet),
        finding.severity,
        finding.confidence,
        finding.title.slice(0, 200),
        finding.description ?? "",
        finding.suggestion ?? null,
        nextStatus,
        runId,
        id,
      ],
    );
    summary.updated++;
    if (reopened) summary.reopened++;
    summary.ids.push(id);
  }

  return summary;
}

/**
 * Close findings a tool stopped reporting.
 *
 * Scoped by rule prefix (`eslint/`, `secrets/`, …) and only called for tools
 * that completed successfully this run — a skipped linter must never mark its
 * previous findings fixed, and an LLM pass over three files must never close
 * findings elsewhere.
 */
export function closeStale(db: Db, runId: number, rulePrefix: string): number {
  const stale = db.count(
    `SELECT COUNT(*) AS n FROM findings
      WHERE rule_id LIKE ? AND status IN ('open','regressed')
        AND (last_seen_run IS NULL OR last_seen_run < ?)`,
    [`${rulePrefix}%`, runId],
  );
  if (stale > 0) {
    db.run(
      `UPDATE findings SET status = 'fixed', fixed_in_run = ?
        WHERE rule_id LIKE ? AND status IN ('open','regressed')
          AND (last_seen_run IS NULL OR last_seen_run < ?)`,
      [runId, `${rulePrefix}%`, runId],
    );
  }
  return stale;
}

export function suppress(
  db: Db,
  options: {
    findingId?: string;
    ruleId?: string;
    pathPrefix?: string;
    reason: string;
    disposition?: "accepted" | "false_positive";
  },
): void {
  const disposition = options.disposition ?? "false_positive";
  if (disposition === "accepted" && !options.findingId) {
    throw new Error("Accepted risk applies to an exact finding, not a rule or path.");
  }
  db.run(
    "INSERT INTO suppressions(finding_id, rule_id, path_prefix, reason, created_at) VALUES(?, ?, ?, ?, ?)",
    [
      options.findingId ?? null,
      options.ruleId ?? null,
      options.pathPrefix ?? null,
      options.reason,
      new Date().toISOString(),
    ],
  );
  if (options.findingId) {
    db.run("UPDATE findings SET status = ? WHERE id = ?", [
      disposition,
      options.findingId,
    ]);
  } else if (options.ruleId || options.pathPrefix) {
    // Rule- and path-level suppressions retire the findings they cover, the
    // same way a direct suppression does. Leaving them open meant the next
    // analyzer run skipped them as suppressed and then closeStale relabelled
    // them "fixed" — a fix nobody made, in a report someone believes.
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.ruleId) {
      clauses.push("rule_id = ?");
      params.push(options.ruleId);
    }
    if (options.pathPrefix) {
      clauses.push("path LIKE ?");
      params.push(`${options.pathPrefix}%`);
    }
    db.run(
      `UPDATE findings SET status = 'false_positive'
        WHERE status IN ('open','regressed') AND ${clauses.join(" AND ")}`,
      params,
    );
  }
}

/** Record what a tool did, including when it was skipped. */
export function recordToolRun(
  db: Db,
  runId: number,
  tool: string,
  status: "ok" | "skipped" | "failed",
  detail: string,
  findings = 0,
): void {
  db.run(
    "INSERT INTO tool_runs(run_id, tool, status, detail, findings) VALUES(?, ?, ?, ?, ?)",
    [runId, tool, status, detail, findings],
  );
}

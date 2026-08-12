/**
 * Edges an agent worked out by reading, which the parser could not derive.
 *
 * Every one carries the evidence that justified it and the hash of the file it
 * was read from. That is the difference between this and a guess: a claim with
 * a citation can be checked, and a claim about code that has since changed can
 * be flagged instead of quietly believed.
 *
 * They are kept in their own table rather than merged into `refs`, so a parsed
 * fact and an asserted one are never confused for each other.
 */

import { createHash } from "node:crypto";
import type { Db } from "../db/db.js";
import {
  meaningFreshness,
  signaturesToRecord,
  type FreshnessVerdict,
} from "../lib/freshness.js";

export const RELATION_KINDS = [
  "calls",
  "registers",
  "handles",
  "implements",
  "configures",
  "emits",
  "reads",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];
const MAX_EVIDENCE_LINE = 4_294_967_295;

export interface RelationInput {
  kind: RelationKind;
  srcPath: string;
  srcSymbol?: string;
  dstPath?: string;
  dstSymbol?: string;
  /** The name the framework knows it by — a route, a node id, an event. */
  label?: string;
  /** The line of code that justifies this. Required. */
  evidence: string;
  evidenceLine?: number;
  confidence?: "definite" | "high" | "medium" | "low";
}

export interface Relation extends RelationInput {
  id: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  /** The source file changed after this was recorded. */
  stale: boolean;
  /** Why, so a reader knows whether to re-check the claim or rewrite it. */
  freshness: FreshnessVerdict;
}

function fingerprint(input: RelationInput): string {
  return createHash("sha256")
    .update(
      [
        input.kind,
        input.srcPath,
        input.srcSymbol ?? "",
        input.dstPath ?? "",
        input.dstSymbol ?? "",
        input.label ?? "",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 20);
}

export function relate(db: Db, input: RelationInput): { id: string; created: boolean } {
  if (!input.evidence?.trim()) {
    throw new Error("Evidence is required — a relation without a citation cannot be checked later.");
  }
  if (
    input.evidenceLine !== undefined &&
    (!Number.isSafeInteger(input.evidenceLine) ||
      input.evidenceLine < 1 ||
      input.evidenceLine > MAX_EVIDENCE_LINE)
  ) {
    throw new Error(`Evidence line must be an integer between 1 and ${MAX_EVIDENCE_LINE}.`);
  }

  const id = fingerprint(input);
  const now = new Date().toISOString();
  // Both signatures: syntax decides whether the assertion drifted, content
  // keeps the exact revision it was asserted against.
  const recorded = signaturesToRecord(db, input.srcPath);

  const existing = db.get<{ id: string }>("SELECT id FROM relations WHERE id = ?", [id]);
  if (existing) {
    db.run(
      `UPDATE relations SET evidence = ?, evidence_line = ?, confidence = ?,
                            content_sha = ?, syntax_sha = ?, updated_at = ?
        WHERE id = ?`,
      [
        input.evidence.trim(),
        input.evidenceLine ?? null,
        input.confidence ?? "medium",
        recorded.contentSha,
        recorded.syntaxSha,
        now,
        id,
      ],
    );
    return { id, created: false };
  }

  db.run(
    `INSERT INTO relations(id, kind, src_path, src_symbol, dst_path, dst_symbol, label,
                           evidence, evidence_line, confidence, source, content_sha, syntax_sha,
                           created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?)`,
    [
      id,
      input.kind,
      input.srcPath,
      input.srcSymbol ?? null,
      input.dstPath ?? null,
      input.dstSymbol ?? null,
      input.label ?? null,
      input.evidence.trim(),
      input.evidenceLine ?? null,
      input.confidence ?? "medium",
      recorded.contentSha,
      recorded.syntaxSha,
      now,
      now,
    ],
  );
  return { id, created: true };
}

interface Row {
  id: string;
  kind: string;
  src_path: string;
  src_symbol: string | null;
  dst_path: string | null;
  dst_symbol: string | null;
  label: string | null;
  evidence: string;
  evidence_line: number | null;
  confidence: string;
  source: string;
  content_sha: string | null;
  syntax_sha: string | null;
  created_at: string;
  updated_at: string;
  current_present: number | null;
  current_sha: string | null;
  current_syntax_sha: string | null;
}

function hydrate(rows: Row[]): Relation[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as RelationKind,
    srcPath: row.src_path,
    ...(row.src_symbol ? { srcSymbol: row.src_symbol } : {}),
    ...(row.dst_path ? { dstPath: row.dst_path } : {}),
    ...(row.dst_symbol ? { dstSymbol: row.dst_symbol } : {}),
    ...(row.label ? { label: row.label } : {}),
    evidence: row.evidence,
    ...(row.evidence_line ? { evidenceLine: row.evidence_line } : {}),
    confidence: row.confidence as RelationInput["confidence"],
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    freshness: verdict(row),
    // Without a source snapshot the claim was never verifiable as current.
    stale: verdict(row).state !== "current",
  }));
}

/**
 * An assertion describes what code means, so a rewritten comment leaves it
 * standing. The verdict carries the reason, because "stale" alone does not
 * tell anyone whether to re-read the claim or rewrite it.
 */
function verdict(row: Row): FreshnessVerdict {
  return meaningFreshness(
    row.src_path,
    { contentSha: row.content_sha, syntaxSha: row.syntax_sha },
    {
      present: row.current_present === 1,
      contentSha: row.current_sha,
      syntaxSha: row.current_syntax_sha,
    },
  );
}

const SELECT = `SELECT r.*, f.present AS current_present, f.content_sha AS current_sha,
                       f.syntax_sha AS current_syntax_sha
                FROM relations r
                LEFT JOIN files f ON f.path = r.src_path AND f.present = 1`;

/**
 * Repoint every assertion about a file that moved.
 *
 * A relation's id is a fingerprint over its own endpoints, so rewriting the
 * path without re-deriving the id leaves a row whose identity no longer
 * describes it — and the next assertion of the same fact computes the new
 * fingerprint, misses it, and inserts a duplicate. The id has to move with the
 * path, which is why this lives beside `fingerprint` rather than in the scan.
 */
export function renameRelationPaths(db: Db, from: string, to: string): void {
  const rows = db.all<Row>(`${SELECT} WHERE r.src_path = ? OR r.dst_path = ?`, [from, from]);
  for (const row of rows) {
    const srcPath = row.src_path === from ? to : row.src_path;
    const dstPath = row.dst_path === from ? to : row.dst_path;
    const id = fingerprint({
      kind: row.kind as RelationKind,
      srcPath,
      srcSymbol: row.src_symbol ?? undefined,
      dstPath: dstPath ?? undefined,
      dstSymbol: row.dst_symbol ?? undefined,
      label: row.label ?? undefined,
      evidence: row.evidence,
    });
    if (id === row.id) continue;
    // The same claim may already have been asserted about the destination.
    // Keeping both would report one fact twice.
    db.run("DELETE FROM relations WHERE id = ?", [id]);
    db.run("UPDATE relations SET id = ?, src_path = ?, dst_path = ? WHERE id = ?", [
      id,
      srcPath,
      dstPath,
      row.id,
    ]);
  }
}

export function relationsFor(db: Db, path: string, symbol?: string): Relation[] {
  const rows = symbol
    ? db.all<Row>(
        `${SELECT} WHERE (r.src_path = ? AND r.src_symbol = ?) OR (r.dst_path = ? AND r.dst_symbol = ?)`,
        [path, symbol, path, symbol],
      )
    : db.all<Row>(`${SELECT} WHERE r.src_path = ? OR r.dst_path = ?`, [path, path]);
  return hydrate(rows);
}

export function listRelations(db: Db, limit = 200): Relation[] {
  return hydrate(db.all<Row>(`${SELECT} ORDER BY r.updated_at DESC LIMIT ?`, [limit]));
}

/** Record that a file was examined, so the loop does not revisit it blindly. */
export function markExplored(db: Db, path: string, found: number, note?: string): void {
  const recorded = signaturesToRecord(db, path);
  db.run(
    `INSERT OR REPLACE INTO explorations(path, content_sha, syntax_sha, found, note, explored_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
    [
      path,
      recorded.contentSha ?? "",
      recorded.syntaxSha,
      found,
      note ?? null,
      new Date().toISOString(),
    ],
  );
}

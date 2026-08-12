/**
 * Following a file when it moves.
 *
 * A scan detects removals by set difference, so renaming a file looks like a
 * deletion and an unrelated creation. Every note, assertion, flow step and
 * exploration written about it is left pointing at a path that no longer
 * exists — knowledge lost to a `git mv`.
 *
 * The dangerous failure is the opposite one: re-anchoring somebody's note onto
 * the wrong code says something false in their name, and says it silently. So
 * correlation is deliberately conservative. Every accepted move needs
 * unambiguous evidence and a one-to-one pairing; anything else keeps today's
 * behaviour, where the overlay degrades to stale and a person decides.
 */

import type { Db } from "../db/db.js";
import type { SourceFile } from "./source.js";

export interface FileMove {
  from: string;
  to: string;
  /** What justified the pairing, recorded so a wrong one can be traced. */
  evidence: "git-rename" | "identical-content";
}

export interface MoveInputs {
  removed: string[];
  added: SourceFile[];
  /** Language of each removed path, from the index. */
  previousLang: Map<string, string>;
  /** Content hash of each removed path, from the index. */
  previousSha: Map<string, string>;
  /** Renames Git already reports, keyed by new path. */
  gitRenames: Map<string, string>;
}

/**
 * Pair removals with additions, accepting only unambiguous matches.
 *
 * Interface signatures are deliberately *not* evidence. Two `index.ts` barrels
 * or two `__init__.py` files routinely share an export surface, and a false
 * pairing here is exactly the silent-wrong-anchor failure this guards against.
 */
export function correlateMoves(inputs: MoveInputs): FileMove[] {
  const { removed, added, previousLang, previousSha, gitRenames } = inputs;
  if (removed.length === 0 || added.length === 0) return [];

  const removedSet = new Set(removed);
  const candidates: FileMove[] = [];

  for (const file of added) {
    const fromGit = gitRenames.get(file.path);
    if (fromGit && removedSet.has(fromGit)) {
      candidates.push({ from: fromGit, to: file.path, evidence: "git-rename" });
      continue;
    }
    for (const from of removed) {
      if (previousSha.get(from) !== file.contentSha) continue;
      if (previousLang.get(from) !== file.lang) continue;
      candidates.push({ from, to: file.path, evidence: "identical-content" });
    }
  }

  // A one-to-many or many-to-one cluster is discarded whole. Two copies of the
  // same file moving at once carry no evidence about which became which, and
  // guessing would be indistinguishable from getting it right.
  const fromCounts = new Map<string, number>();
  const toCounts = new Map<string, number>();
  for (const move of candidates) {
    fromCounts.set(move.from, (fromCounts.get(move.from) ?? 0) + 1);
    toCounts.set(move.to, (toCounts.get(move.to) ?? 0) + 1);
  }

  return candidates.filter(
    (move) => fromCounts.get(move.from) === 1 && toCounts.get(move.to) === 1,
  );
}

/**
 * Carry authored knowledge across a confirmed move.
 *
 * `path` is part of the primary key on several of these tables, so a plain
 * UPDATE throws when a row already exists at the destination — which happens
 * whenever somebody has already written about the new path. `OR REPLACE` keeps
 * the destination's own row and drops the carried duplicate.
 *
 * Findings are deliberately not moved: they survive by fingerprint and are
 * re-detected against the new path on this same scan, so carrying them would
 * double-count.
 */
export function applyMove(db: Db, runId: number, move: FileMove): void {
  db.run("UPDATE files SET moved_to = ? WHERE path = ?", [move.to, move.from]);
  db.run(
    `INSERT OR REPLACE INTO file_moves(run_id, from_path, to_path, evidence, moved_at)
     VALUES(?, ?, ?, ?, ?)`,
    [runId, move.from, move.to, move.evidence, new Date().toISOString()],
  );

  db.run("UPDATE relations SET src_path = ? WHERE src_path = ?", [move.to, move.from]);
  db.run("UPDATE relations SET dst_path = ? WHERE dst_path = ?", [move.to, move.from]);
  db.run("UPDATE flow_steps SET path = ? WHERE path = ?", [move.to, move.from]);

  db.run("UPDATE OR REPLACE memory_anchors SET path = ? WHERE path = ?", [move.to, move.from]);
  db.run("UPDATE OR REPLACE component_snapshot SET path = ? WHERE path = ?", [move.to, move.from]);
  db.run("UPDATE OR REPLACE node_tags SET path = ? WHERE path = ?", [move.to, move.from]);
  db.run("UPDATE OR REPLACE explorations SET path = ? WHERE path = ?", [move.to, move.from]);

  // Only an exact-path membership follows. A prefix like `src/auth/` becoming
  // `src/identity/` is a directory move somebody should re-author deliberately,
  // not something to rewrite underneath them.
  db.run("UPDATE OR REPLACE component_members SET pattern = ? WHERE pattern = ?", [
    move.to,
    move.from,
  ]);
}

/**
 * Authored rows still pointing at paths the index no longer has.
 *
 * Deleting them would throw away knowledge over a temporary state — a file
 * moved outside Git, a branch switched. Leaving them invisible is what makes
 * "no orphan facts" untrue. Listing them is the third option: an orphan a
 * person can see and resolve is not an orphan fact.
 */
export function orphanedOverlays(
  db: Db,
  limit = 50,
): Array<{ kind: string; path: string; label: string }> {
  const absent = `AND NOT EXISTS (SELECT 1 FROM files f WHERE f.path = o.path AND f.present = 1)`;
  const rows: Array<{ kind: string; path: string; label: string }> = [];

  for (const [kind, sql] of [
    [
      "memory",
      `SELECT o.path AS path, m.title AS label FROM memory_anchors o
         JOIN memories m ON m.id = o.memory_id AND m.status = 'active' ${absent}`,
    ],
    [
      "relation",
      `SELECT o.src_path AS path, COALESCE(o.label, o.kind) AS label FROM relations o
        WHERE 1 = 1 AND NOT EXISTS (
          SELECT 1 FROM files f WHERE f.path = o.src_path AND f.present = 1)`,
    ],
    [
      "flow-step",
      `SELECT o.path AS path, o.label AS label FROM flow_steps o
        WHERE o.path IS NOT NULL ${absent}`,
    ],
  ] as const) {
    for (const row of db.all<{ path: string; label: string | null }>(`${sql} LIMIT ?`, [limit])) {
      rows.push({ kind, path: row.path, label: row.label ?? "" });
    }
  }

  return rows.slice(0, limit);
}

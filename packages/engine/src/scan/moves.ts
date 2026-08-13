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
import { renameRelationPaths } from "../graph/relations.js";
import { refreshMemberDigests } from "../graph/map.js";
import { likeEscape } from "../lib/sql.js";

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

  // Git's own similarity detection is authoritative, so its pairs are taken
  // first and their endpoints reserved. Mixing them into one candidate pool
  // let an unrelated file that happened to match the old content make a
  // confirmed rename look ambiguous, discarding both.
  const confirmed: FileMove[] = [];
  const claimedFrom = new Set<string>();
  const claimedTo = new Set<string>();
  for (const file of added) {
    const fromGit = gitRenames.get(file.path);
    if (!fromGit || !removedSet.has(fromGit) || claimedFrom.has(fromGit)) continue;
    confirmed.push({ from: fromGit, to: file.path, evidence: "git-rename" });
    claimedFrom.add(fromGit);
    claimedTo.add(file.path);
  }

  const candidates: FileMove[] = [];
  for (const file of added) {
    if (claimedTo.has(file.path)) continue;
    for (const from of removed) {
      if (claimedFrom.has(from)) continue;
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

  return [
    ...confirmed,
    ...candidates.filter(
      (move) => fromCounts.get(move.from) === 1 && toCounts.get(move.to) === 1,
    ),
  ];
}

/**
 * Carry authored knowledge across a confirmed move.
 *
 * `path` is part of the primary key on several of these tables, so a plain
 * UPDATE throws when a row already exists at the destination — which happens
 * whenever somebody has already written about the new path. `OR REPLACE`
 * deletes the pre-existing destination row and lets the carried one land. Both
 * describe the same file at the same path, so either is correct; what matters
 * is that the move does not abort the scan.
 *
 * Findings move with the file rather than being closed as fixed by the removal
 * pass — a scan runs no analyzers, so "fixed" would be untrue. Their ids are
 * fingerprints over the path, so the next analyzer run re-keys them through
 * `record.ts`, which reads the move recorded here.
 */
export function applyMove(db: Db, runId: number, move: FileMove): void {
  db.run("UPDATE files SET moved_to = ? WHERE path = ?", [move.to, move.from]);
  db.run(
    `INSERT OR REPLACE INTO file_moves(run_id, from_path, to_path, evidence, moved_at)
     VALUES(?, ?, ?, ?, ?)`,
    [runId, move.from, move.to, move.evidence, new Date().toISOString()],
  );

  // Relations own their identity, so the rename goes through the module that
  // derives it rather than rewriting the column here.
  renameRelationPaths(db, move.from, move.to);
  db.run("UPDATE flow_steps SET path = ? WHERE path = ?", [move.to, move.from]);

  db.run("UPDATE OR REPLACE memory_anchors SET path = ? WHERE path = ?", [move.to, move.from]);

  // `components.member_digest` hashes member paths, so moving only the
  // snapshot left the box permanently drifted while `mapDrift` compared the
  // moved snapshot with current files and found nothing to name — drift with
  // an empty changed-file list, which nobody can act on. Recomputing the
  // aggregate from the moved snapshot keeps the two consistent.
  const affected = db.all<{ component_id: string }>(
    "SELECT DISTINCT component_id FROM component_snapshot WHERE path = ?",
    [move.from],
  );
  db.run("UPDATE OR REPLACE component_snapshot SET path = ? WHERE path = ?", [move.to, move.from]);
  for (const component of affected) refreshMemberDigests(db, component.component_id);
  db.run("UPDATE OR REPLACE node_tags SET path = ? WHERE path = ?", [move.to, move.from]);
  db.run("UPDATE OR REPLACE explorations SET path = ? WHERE path = ?", [move.to, move.from]);

  // A symbol key embeds its path, so a recorded dependency on a moved file
  // matches nothing afterwards and the box reports drift forever, naming a
  // symbol with no path. The interface signature does not embed the path, so
  // rewriting the prefix lets the comparison keep doing its job.
  db.run(
    `UPDATE OR REPLACE artifact_dependencies
        SET depends_on = ? || substr(depends_on, ?)
      WHERE signature_kind = 'symbol-interface' AND depends_on LIKE ? ESCAPE '\\'`,
    [`${move.to}#`, move.from.length + 2, `${likeEscape(move.from)}#%`],
  );

  // The file was renamed, not repaired. Leaving these behind lets the removal
  // pass close them as fixed, which is a claim no scan is entitled to make.
  db.run("UPDATE findings SET path = ? WHERE path = ?", [move.to, move.from]);
  db.run("UPDATE suppressions SET path_prefix = ? WHERE path_prefix = ?", [move.to, move.from]);

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
  /** The path column differs per table; the absence test does not. */
  const absent = (column: string) =>
    `NOT EXISTS (SELECT 1 FROM files f WHERE f.path = ${column} AND f.present = 1)`;

  const rows: Array<{ kind: string; path: string; label: string }> = [];
  for (const [kind, sql] of [
    [
      "memory",
      `SELECT a.path AS path, m.title AS label
         FROM memory_anchors a
         JOIN memories m ON m.id = a.memory_id
        WHERE m.status = 'active' AND ${absent("a.path")}`,
    ],
    [
      "relation",
      // Either endpoint can go missing. Checking only the source reported an
      // assertion as fully anchored while its destination no longer existed.
      `SELECT r.src_path AS path, COALESCE(r.label, r.kind) AS label
         FROM relations r
        WHERE ${absent("r.src_path")}
        UNION
       SELECT r.dst_path AS path, COALESCE(r.label, r.kind) AS label
         FROM relations r
        WHERE r.dst_path IS NOT NULL AND ${absent("r.dst_path")}`,
    ],
    [
      "flow-step",
      `SELECT s.path AS path, s.label AS label
         FROM flow_steps s
        WHERE s.path IS NOT NULL AND ${absent("s.path")}`,
    ],
  ] as const) {
    for (const row of db.all<{ path: string; label: string | null }>(
      `${sql} ORDER BY path LIMIT ?`,
      [limit],
    )) {
      rows.push({ kind, path: row.path, label: row.label ?? "" });
    }
  }

  return rows.slice(0, limit);
}

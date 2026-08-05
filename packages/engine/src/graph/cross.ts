/**
 * Questions that span every repository the engine knows.
 *
 * This is the one thing a per-session tool structurally cannot do. "Where else
 * do we use this package", "who else defines a function by this name", "did we
 * already decide this somewhere else" — all need several indexes open at once,
 * which is exactly what a daemon has and a spawned-per-session process does
 * not.
 */

import { getDb } from "../db/db.js";
import { recall as recallMemories } from "../memory/store.js";

export const CROSS_KINDS = ["package", "symbol", "memory", "finding", "file"] as const;
export type CrossKind = (typeof CROSS_KINDS)[number];

export interface WorkspaceRef {
  id: string;
  name: string;
  root: string;
}

export interface CrossHit {
  workspace: string;
  root: string;
  detail: Record<string, unknown>;
}

export interface CrossResult {
  kind: CrossKind;
  query: string;
  searched: number;
  /** Workspaces whose store could not be read, rather than silently skipped. */
  unreadable: string[];
  totals: Record<string, number>;
  hits: CrossHit[];
}

export async function crossQuery(
  workspaces: WorkspaceRef[],
  kind: CrossKind,
  query: string,
  limit = 20,
): Promise<CrossResult> {
  const hits: CrossHit[] = [];
  const totals: Record<string, number> = {};
  const unreadable: string[] = [];
  const like = `%${query}%`;

  for (const workspace of workspaces) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      const db = await getDb(workspace.root);

      if (kind === "package") {
        rows = db.all(
          `SELECT external AS package, COUNT(DISTINCT src_path) AS used_by
           FROM edges WHERE external IS NOT NULL AND LOWER(external) LIKE LOWER(?)
           GROUP BY external ORDER BY used_by DESC LIMIT ?`,
          [like, limit],
        );
      } else if (kind === "symbol") {
        rows = db.all(
          `SELECT s.name, s.kind, s.path, s.start_line,
                  (SELECT COUNT(*) FROM refs r WHERE r.dst_path = s.path AND r.name = s.name) AS ref_count
           FROM symbols s WHERE s.name = ? OR LOWER(s.name) LIKE LOWER(?)
           ORDER BY ref_count DESC LIMIT ?`,
          [query, like, limit],
        );
      } else if (kind === "file") {
        rows = db.all(
          "SELECT path, lang, loc FROM files WHERE present = 1 AND LOWER(path) LIKE LOWER(?) ORDER BY path LIMIT ?",
          [like, limit],
        );
      } else if (kind === "finding") {
        rows = db.all(
          `SELECT id, rule_id, severity, path, line_start, title
           FROM findings WHERE status IN ('open','regressed')
             AND (LOWER(title) LIKE LOWER(?) OR LOWER(rule_id) LIKE LOWER(?))
           LIMIT ?`,
          [like, like, limit],
        );
      } else {
        rows = recallMemories(db, query, limit) as unknown as Array<Record<string, unknown>>;
      }
    } catch {
      unreadable.push(workspace.name);
      continue;
    }

    if (rows.length === 0) continue;
    totals[workspace.name] = rows.length;
    for (const row of rows) {
      hits.push({ workspace: workspace.name, root: workspace.root, detail: row });
    }
  }

  return {
    kind,
    query,
    searched: workspaces.length,
    unreadable,
    totals,
    hits,
  };
}

/**
 * Questions that span every repository the engine knows.
 *
 * This is the one thing a per-session tool structurally cannot do. "Where else
 * do we use this package", "who else defines a function by this name", "did we
 * already decide this somewhere else" — all need several indexes open at once,
 * which is exactly what a daemon has and a spawned-per-session process does
 * not.
 */

import { getExistingDb, KNOWLEDGE_KINDS } from "../db/db.js";
import { memoriesByIds } from "../memory/store.js";

export const CROSS_KINDS = ["all", "package", ...KNOWLEDGE_KINDS] as const;
export type CrossKind = (typeof CROSS_KINDS)[number];
export const MAX_SEARCH_QUERY_LENGTH = 512;

export function normalizeSearchQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw new Error("Search query must not be blank.");
  if ([...normalized].length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters.`);
  }
  return normalized;
}

function normalizeSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new Error("Search limit must be finite.");
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

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
  const normalizedQuery = normalizeSearchQuery(query);
  const normalizedLimit = normalizeSearchLimit(limit);
  const rankedHits: Array<{ hit: CrossHit; localRank: number }> = [];
  const totals: Record<string, number> = {};
  const unreadable: string[] = [];

  for (const workspace of workspaces) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      // Cross-workspace search is read-only and must not manufacture a blank
      // store for a registered repository whose index is missing or corrupt.
      const db = await getExistingDb(workspace.root);

      if (kind === "package") {
        rows = db.all(
          `SELECT external AS package, COUNT(DISTINCT src_path) AS used_by
           FROM edges
           WHERE external IS NOT NULL AND INSTR(LOWER(external), LOWER(?)) > 0
           GROUP BY external ORDER BY used_by DESC LIMIT ?`,
          [normalizedQuery, normalizedLimit],
        );
      } else {
        const kinds = kind === "all" ? [] : [kind];
        const knowledgeHits = db.searchKnowledge(normalizedQuery, kinds, normalizedLimit);
        const memoryById = new Map(
          memoriesByIds(
            db,
            knowledgeHits
              .filter((hit) => hit.kind === "memory")
              .map((hit) => hit.sourceId),
          ).map((memory) => [memory.id, memory]),
        );
        rows = knowledgeHits.map((hit) => {
          const memory = hit.kind === "memory" ? memoryById.get(hit.sourceId) : undefined;
          return {
            id: hit.sourceId,
            sourceId: hit.sourceId,
            kind: hit.kind,
            title: hit.title,
            // Keep the old symbol result's most useful field while giving every
            // result class one stable shape for the desktop and MCP clients.
            ...(hit.kind === "symbol" ? { name: hit.title } : {}),
            path: hit.path || null,
            symbol: hit.symbol || null,
            excerpt: hit.excerpt,
            score: hit.score,
            updatedAt: hit.updatedAt,
            ...(hit.lineStart
              ? {
                  lineStart: hit.lineStart,
                  lineEnd: hit.lineEnd ?? hit.lineStart,
                }
              : {}),
            ...(hit.kind === "finding" ? { evidenceSha: hit.evidenceSha } : {}),
            ...(memory
              ? {
                  memoryKind: memory.kind,
                  body: memory.body,
                  source: memory.source,
                  status: memory.status,
                  createdAt: memory.createdAt,
                  updatedAt: memory.updatedAt,
                  anchors: memory.anchors,
                  stale: memory.anchors.some((anchor) => anchor.stale),
                }
              : {}),
          };
        });
      }
    } catch {
      unreadable.push(workspace.name);
      continue;
    }

    if (rows.length === 0) continue;
    totals[workspace.name] = rows.length;
    for (const [localRank, row] of rows.entries()) {
      rankedHits.push({
        localRank,
        hit: { workspace: workspace.name, root: workspace.root, detail: row },
      });
    }
  }

  // FTS5 BM25 scores depend on each workspace's corpus and are not comparable
  // across databases. Interleave the already-ranked local streams by ordinal,
  // preserving exact-match priority and avoiding false global precision.
  rankedHits.sort((left, right) => {
    const byRank = left.localRank - right.localRank;
    if (byRank !== 0) return byRank;
    const byWorkspace = left.hit.workspace.localeCompare(right.hit.workspace);
    if (byWorkspace !== 0) return byWorkspace;
    return String(left.hit.detail.title ?? left.hit.detail.package ?? "").localeCompare(
      String(right.hit.detail.title ?? right.hit.detail.package ?? ""),
    );
  });
  const hits = rankedHits.map(({ hit }) => hit);

  return {
    kind,
    query: normalizedQuery,
    searched: workspaces.length,
    unreadable,
    totals,
    hits,
  };
}

/**
 * What the map cannot explain.
 *
 * A scan produces a map of what exists. It is silent about meaning, and worse,
 * it is silent about its own silence — a call graph with a hole in it looks
 * exactly like a call graph with nothing there.
 *
 * This finds the holes and ranks them, so an agent can be sent to read the
 * code and write back what the parser could not derive. That is the loop: the
 * scan says where to look, the agent says what is there, and the answer lands
 * in `relations` where the next session inherits it.
 *
 * Found on a real repository: a LangGraph project whose entire control flow is
 * `graph.add_node("classify", classify_node)`. Every node function looked like
 * an unreachable entry point, and the flow view showed type inheritance where
 * the actual workflow should have been.
 */

import type { Db } from "../db/db.js";
import { sameMeaning } from "../lib/freshness.js";

export type GapKind =
  | "dynamic-dispatch"
  | "orphan-entry"
  | "unresolved-import"
  | "undocumented-hub"
  | "stale-note";

export interface Gap {
  kind: GapKind;
  path: string;
  symbol: string | null;
  /** Why this is worth an agent's time, in the order they should be spent. */
  reason: string;
  /** What to look for once there. */
  hint: string;
  score: number;
  explored: boolean;
}

/**
 * Registration APIs whose arguments are edges the parser cannot follow.
 *
 * Deliberately a list of shapes rather than framework names: `add_node` means
 * the same thing in LangGraph as `register` does in a plugin system, and
 * matching the shape covers frameworks nobody has written yet.
 */
const DISPATCH_MARKERS = [
  "add_node",
  "add_edge",
  "add_conditional_edges",
  "register",
  "route",
  "on_event",
  "subscribe",
  "addEventListener",
  "setHandler",
  "use(",
  "dispatch",
  "getattr(",
  "importlib",
  "__subclasses__",
];

export interface GapsResult {
  gaps: Gap[];
  totals: Record<string, number>;
  /** Share of files that have been looked at since they last changed. */
  coverage: { explored: number; total: number; percent: number };
}

export function findGaps(db: Db, limit = 25): GapsResult {
  const gaps: Gap[] = [];

  // Reading a file is understanding what it does, so reformatting it does not
  // make it unread.
  //
  // Both sides keep both signatures and are compared pairwise through the
  // shared rule. Coalescing each side independently compared an exploration
  // recorded before syntax signatures against a file that has one since — old
  // content hash versus new syntax hash, which can never match, so every
  // pre-upgrade exploration would read unexplored forever.
  const explored = new Map(
    db
      .all<{ path: string; content_sha: string; syntax_sha: string | null }>(
        "SELECT path, content_sha, syntax_sha FROM explorations",
      )
      .map((row) => [row.path, { contentSha: row.content_sha, syntaxSha: row.syntax_sha }]),
  );

  const files = db.all<{
    path: string;
    content_sha: string;
    syntax_sha: string | null;
    loc: number;
    churn: number;
  }>(
    `SELECT path, content_sha, syntax_sha, loc, churn FROM files
     WHERE present = 1 AND lang IN ('typescript','javascript','python') AND is_test = 0`,
  );
  // One map, because there were five call sites and three of them reached for
  // the content hash while the exploration row now stores syntax — leaving
  // those gap kinds permanently unexplored for every parsed file.
  const signatureOf = new Map(
    files.map((file) => [
      file.path,
      { contentSha: file.content_sha, syntaxSha: file.syntax_sha },
    ]),
  );
  const isExplored = (path: string): boolean => {
    const recorded = explored.get(path);
    const current = signatureOf.get(path);
    return recorded !== undefined && current !== undefined && sameMeaning(recorded, current);
  };

  // --- dispatch that the parser cannot follow -----------------------------
  for (const file of files) {
    const symbols = db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = ?", [file.path]);
    if (symbols === 0) continue;

    const marker = db.get<{ signature: string }>(
      `SELECT signature FROM symbols WHERE path = ? AND (${DISPATCH_MARKERS.map(
        () => "signature LIKE ?",
      ).join(" OR ")}) LIMIT 1`,
      [file.path, ...DISPATCH_MARKERS.map((token) => `%${token}%`)],
    );

    // Two signals, and the second matters more than it first appeared.
    //
    // A marker in a symbol signature only catches registration at module
    // level. The calls that matter are usually inside a build() function, so
    // the signature is just "def build(...)" and the marker never matches —
    // which is how the most important file in a LangGraph project, its
    // graph.py, was missed entirely. Naming is the more reliable signal, and
    // requiring few outgoing references suppressed exactly the files that
    // import every node they wire together.
    const namedLikeWiring = /(^|\/)(graph|wiring|registry|router|routes|plugins?|orchestrat\w*)\.[a-z]+$/i.test(
      file.path,
    );
    const looksLikeWiring = Boolean(marker) || namedLikeWiring;

    if (looksLikeWiring) {
      gaps.push({
        kind: "dynamic-dispatch",
        path: file.path,
        symbol: null,
        reason:
          "Registers behaviour rather than calling it, so the edges it creates are invisible to the parser.",
        hint: "Read the registrations and record each one as a relation: which name maps to which function, and in what order they run.",
        // A file named for wiring outranks one that merely mentions a marker.
        score: (namedLikeWiring ? 140 : 100) + Math.min(file.churn, 20),
        explored: isExplored(file.path),
      });
    }
  }

  // --- callable things nothing reaches ------------------------------------
  // Real entry points are few. A pile of them usually means dispatch is
  // happening somewhere the parser did not see.
  const orphans = db.all<{ name: string; path: string }>(
    `SELECT s.name, s.path FROM symbols s
     JOIN files f ON f.path = s.path
     WHERE s.kind IN ('function','class') AND s.exported = 1
       AND f.present = 1 AND f.is_test = 0
       AND NOT EXISTS (
         SELECT 1 FROM refs r
         WHERE r.dst_symbol_id = s.id OR
           (r.dst_symbol_id IS NULL AND r.name = s.name AND r.dst_path = s.path AND
            (SELECT COUNT(*) FROM symbols same
              WHERE same.path = s.path AND same.name = s.name) = 1)
       )
       AND NOT EXISTS (
         SELECT 1 FROM relations rel
         JOIN files source ON source.path = rel.src_path AND source.present = 1
         WHERE rel.dst_symbol = s.name AND rel.dst_path = s.path
           AND rel.content_sha IS NOT NULL
           AND CASE
                 WHEN rel.syntax_sha IS NOT NULL AND source.syntax_sha IS NOT NULL
                   THEN rel.syntax_sha = source.syntax_sha
                 ELSE rel.content_sha = source.content_sha
               END
       )
     LIMIT 400`,
  );
  const orphansByFile = new Map<string, string[]>();
  for (const orphan of orphans) {
    orphansByFile.set(orphan.path, [...(orphansByFile.get(orphan.path) ?? []), orphan.name]);
  }
  for (const [path, names] of orphansByFile) {
    if (names.length < 2) continue;
    gaps.push({
      kind: "orphan-entry",
      path,
      symbol: names.slice(0, 4).join(", "),
      reason: `${names.length} exported symbols here are called from nowhere the parser can see.`,
      hint: "Find what invokes them — a registry, a config file, a framework convention — and record the relation.",
      score: 60 + names.length * 3,
      explored: isExplored(path),
    });
  }

  // --- imports that resolved to nothing ------------------------------------
  const unresolved = db.all<{ src_path: string; n: number }>(
    `SELECT src_path, COUNT(*) AS n FROM edges
     WHERE dst_path IS NULL AND external IS NULL
     GROUP BY src_path ORDER BY n DESC LIMIT 20`,
  );
  for (const row of unresolved) {
    gaps.push({
      kind: "unresolved-import",
      path: row.src_path,
      symbol: null,
      reason: `${row.n} import(s) resolved to neither a file nor a package.`,
      hint: "Usually an alias or a path mapping the resolver does not know. Confirm where they point.",
      score: 40 + row.n,
      explored: isExplored(row.src_path),
    });
  }

  // --- heavily used, never explained ---------------------------------------
  const hubs = db.all<{ path: string; fan_in: number }>(
    `SELECT f.path, (SELECT COUNT(*) FROM edges e WHERE e.dst_path = f.path) AS fan_in
     FROM files f
     WHERE f.present = 1 AND f.is_test = 0
       AND NOT EXISTS (SELECT 1 FROM memory_anchors a WHERE a.path = f.path)
     ORDER BY fan_in DESC LIMIT 8`,
  );
  for (const hub of hubs) {
    if (hub.fan_in < 5) continue;
    gaps.push({
      kind: "undocumented-hub",
      path: hub.path,
      symbol: null,
      reason: `${hub.fan_in} files depend on this and nothing has been recorded about why.`,
      hint: "Work out the contract it provides and record it as a decision or constraint.",
      score: 30 + hub.fan_in,
      explored: isExplored(hub.path),
    });
  }

  // --- notes written against code that has moved ---------------------------
  const stale = db.all<{ path: string; symbol: string; title: string }>(
    `SELECT a.path, a.symbol, m.title FROM memory_anchors a
     JOIN memories m ON m.id = a.memory_id
     LEFT JOIN files f ON f.path = a.path
     WHERE m.status = 'active'
       AND (a.content_sha IS NULL OR f.path IS NULL OR f.present = 0
            OR CASE
                 WHEN a.syntax_sha IS NOT NULL AND f.syntax_sha IS NOT NULL
                   THEN a.syntax_sha != f.syntax_sha
                 ELSE a.content_sha != f.content_sha
               END)
     LIMIT 20`,
  );
  for (const row of stale) {
    gaps.push({
      kind: "stale-note",
      path: row.path,
      symbol: row.symbol || null,
      reason: `"${row.title}" was recorded against an older version of this file.`,
      hint: "Confirm it still holds, update it, or supersede it.",
      score: 70,
      explored: false,
    });
  }

  const ranked = gaps
    .filter((gap) => !gap.explored)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const totals: Record<string, number> = {};
  for (const gap of gaps) totals[gap.kind] = (totals[gap.kind] ?? 0) + 1;

  const exploredCount = files.filter((file) => isExplored(file.path)).length;
  return {
    gaps: ranked,
    totals,
    coverage: {
      explored: exploredCount,
      total: files.length,
      percent: files.length ? Math.round((exploredCount / files.length) * 100) : 0,
    },
  };
}

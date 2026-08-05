/**
 * Call chains.
 *
 * Imports answer "can this file see that one" — a containment relation, and a
 * weak one: a file importing a 40-export module tells you almost nothing about
 * what it actually does. Tracing a request through handler, service and
 * repository is a different question, and it is asked symbol to symbol.
 *
 * `refs` records where a use occurs and now which symbol it occurs inside, so
 * caller and callee are both known and the chain can be walked. That is the
 * relation a person means by "trace this endpoint", and imports never carried
 * it.
 */

import type { Db } from "../db/db.js";

export interface TraceNode {
  symbol: string;
  path: string;
  kind: string | null;
  line: number | null;
  depth: number;
  /** How this was reached — the caller, or the callee, depending on direction. */
  via: string | null;
  /** True when expansion stopped here because the depth limit was reached. */
  truncated: boolean;
}

export interface TraceResult {
  root: string;
  rootPath: string | null;
  direction: "callees" | "callers";
  depth: number;
  nodes: TraceNode[];
  /** Rendered chains, deepest first — the thing a person actually reads. */
  chains: string[];
  /** Symbols reached whose own callees are outside what we can resolve. */
  leaves: string[];
  cycles: string[];
  /**
   * True when the node cap stopped expansion. A capped trace looks exactly
   * like a complete one otherwise, and "not shown" must never read as
   * "not called".
   */
  truncated: boolean;
}

interface Edge {
  from: string;
  fromPath: string;
  to: string;
  toPath: string;
}

/**
 * Only things that can appear in a chain.
 *
 * A reference to a local const is a real reference, but "handler → someLocal"
 * is not a step in a call path, and including them buries the two or three
 * hops anyone actually wanted in dozens of variable bindings.
 */
const CALLABLE = "('function','method','class')";

/**
 * One hop, in whichever direction.
 *
 * Callees: uses that occur *inside* this symbol. Callers: uses of this symbol
 * that occur inside some other. Both come from the same table read two ways,
 * which is the point of storing the caller alongside the target.
 */
function step(db: Db, symbol: string, path: string, direction: "callees" | "callers"): Edge[] {
  if (direction === "callees") {
    return db
      .all<{ name: string; dst_path: string }>(
        `SELECT DISTINCT r.name, r.dst_path
         FROM refs r
         WHERE r.src_path = ? AND r.src_symbol = ? AND r.dst_path IS NOT NULL
           AND NOT (r.dst_path = r.src_path AND r.name = r.src_symbol)
           AND EXISTS (
             SELECT 1 FROM symbols s
             WHERE s.path = r.dst_path AND s.name = r.name AND s.kind IN ${CALLABLE}
           )`,
        [path, symbol],
      )
      .map((row) => ({ from: symbol, fromPath: path, to: row.name, toPath: row.dst_path }));
  }

  return db
    .all<{ src_symbol: string; src_path: string }>(
      `SELECT DISTINCT r.src_symbol, r.src_path
       FROM refs r
       WHERE r.name = ? AND r.dst_path = ? AND r.src_symbol IS NOT NULL
         AND NOT (r.src_path = r.dst_path AND r.src_symbol = r.name)
         AND EXISTS (
           SELECT 1 FROM symbols s
           WHERE s.path = r.src_path AND s.name = r.src_symbol AND s.kind IN ${CALLABLE}
         )`,
      [symbol, path],
    )
    .map((row) => ({
      from: row.src_symbol,
      fromPath: row.src_path,
      to: symbol,
      toPath: path,
    }));
}

function locate(db: Db, symbol: string, path?: string): { path: string; kind: string; line: number } | null {
  const row = path
    ? db.get<{ path: string; kind: string; start_line: number }>(
        "SELECT path, kind, start_line FROM symbols WHERE name = ? AND path = ? LIMIT 1",
        [symbol, path],
      )
    : db.get<{ path: string; kind: string; start_line: number }>(
        "SELECT path, kind, start_line FROM symbols WHERE name = ? ORDER BY exported DESC LIMIT 1",
        [symbol],
      );
  return row ? { path: row.path, kind: row.kind, line: row.start_line } : null;
}

export function trace(
  db: Db,
  symbol: string,
  options: { direction?: "callees" | "callers"; depth?: number; path?: string; maxNodes?: number } = {},
): TraceResult {
  const direction = options.direction ?? "callees";
  const maxDepth = Math.min(options.depth ?? 4, 10);
  const maxNodes = options.maxNodes ?? 200;

  const root = locate(db, symbol, options.path);
  if (!root) {
    return {
      root: symbol,
      rootPath: null,
      direction,
      depth: maxDepth,
      nodes: [],
      chains: [],
      leaves: [],
      cycles: [],
      truncated: false,
    };
  }

  const key = (name: string, path: string): string => `${path}#${name}`;
  const seen = new Map<string, TraceNode>();
  const cycles: string[] = [];
  const leaves: string[] = [];
  let hitNodeCap = false;
  const parents = new Map<string, string>();

  seen.set(key(symbol, root.path), {
    symbol,
    path: root.path,
    kind: root.kind,
    line: root.line,
    depth: 0,
    via: null,
    truncated: false,
  });

  let frontier: Array<{ name: string; path: string; depth: number }> = [
    { name: symbol, path: root.path, depth: 0 },
  ];

  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const current of frontier) {
      if (current.depth >= maxDepth) {
        const node = seen.get(key(current.name, current.path));
        if (node) node.truncated = true;
        continue;
      }

      const edges = step(db, current.name, current.path, direction);
      if (edges.length === 0) {
        leaves.push(key(current.name, current.path));
        continue;
      }

      for (const edge of edges) {
        const [name, path] =
          direction === "callees" ? [edge.to, edge.toPath] : [edge.from, edge.fromPath];
        const id = key(name, path);

        if (seen.has(id)) {
          // A cycle is reaching an *ancestor on this chain*. Anything else
          // already seen is reconvergence — two callers sharing a callee is
          // the normal shape of a DAG, and reporting a diamond as a cycle
          // sends someone hunting for recursion that does not exist.
          const from = key(current.name, current.path);
          let ancestor: string | undefined = from;
          while (ancestor && ancestor !== id) ancestor = parents.get(ancestor);
          if (ancestor === id || id === from) {
            const label = `${from} → ${id}`;
            if (!cycles.includes(label)) cycles.push(label);
          }
          continue;
        }
        if (seen.size >= maxNodes) {
          hitNodeCap = true;
          continue;
        }

        const found = locate(db, name, path);
        seen.set(id, {
          symbol: name,
          path,
          kind: found?.kind ?? null,
          line: found?.line ?? null,
          depth: current.depth + 1,
          via: key(current.name, current.path),
          truncated: false,
        });
        parents.set(id, key(current.name, current.path));
        next.push({ name, path, depth: current.depth + 1 });
      }
    }

    frontier = next;
  }

  // Render each leaf back to the root, so the output reads as a path rather
  // than a set of nodes someone has to reassemble.
  const chains: string[] = [];
  const deepest = [...seen.values()].sort((a, b) => b.depth - a.depth);
  const covered = new Set<string>();

  for (const node of deepest) {
    const id = key(node.symbol, node.path);
    if (covered.has(id) || node.depth === 0) continue;

    const parts: string[] = [];
    let cursor: string | undefined = id;
    while (cursor) {
      covered.add(cursor);
      const entry = seen.get(cursor);
      if (!entry) break;
      parts.unshift(`${entry.symbol} (${entry.path})`);
      cursor = parents.get(cursor);
    }
    chains.push(
      direction === "callees" ? parts.join("\n  → ") : [...parts].reverse().join("\n  → "),
    );
    if (chains.length >= 25) break;
  }

  return {
    root: symbol,
    rootPath: root.path,
    direction,
    depth: maxDepth,
    nodes: [...seen.values()].sort((a, b) => a.depth - b.depth),
    chains,
    leaves,
    cycles,
    truncated: hitNodeCap,
  };
}

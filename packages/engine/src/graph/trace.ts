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
  id: string;
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

interface SymbolRow {
  id: string;
  symbol: string;
  path: string;
  kind: string;
  line: number;
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
function step(db: Db, symbolId: string, direction: "callees" | "callers"): SymbolRow[] {
  if (direction === "callees") {
    return db.all<SymbolRow>(
      `SELECT DISTINCT s.id, s.name AS symbol, s.path, s.kind, s.start_line AS line
       FROM refs r JOIN symbols s ON s.id = r.dst_symbol_id
       WHERE r.src_symbol_id = ? AND r.dst_symbol_id IS NOT NULL
         AND r.dst_symbol_id != r.src_symbol_id AND s.kind IN ${CALLABLE}`,
      [symbolId],
    );
  }

  return db.all<SymbolRow>(
    `SELECT DISTINCT s.id, s.name AS symbol, s.path, s.kind, s.start_line AS line
     FROM refs r JOIN symbols s ON s.id = r.src_symbol_id
     WHERE r.dst_symbol_id = ? AND r.src_symbol_id IS NOT NULL
       AND r.src_symbol_id != r.dst_symbol_id AND s.kind IN ${CALLABLE}`,
    [symbolId],
  );
}

function locate(
  db: Db,
  symbol: string,
  options: { path?: string; line?: number; symbolId?: string },
): SymbolRow | null {
  if (options.symbolId) {
    return db.get<SymbolRow>(
      "SELECT id, name AS symbol, path, kind, start_line AS line FROM symbols WHERE id = ?",
      [options.symbolId],
    );
  }
  const clauses = ["name = ?"];
  const params: Array<string | number> = [symbol];
  if (options.path) {
    clauses.push("path = ?");
    params.push(options.path);
  }
  if (options.line) {
    clauses.push("start_line = ?");
    params.push(options.line);
  }
  const rows = db.all<SymbolRow>(
    `SELECT id, name AS symbol, path, kind, start_line AS line FROM symbols
     WHERE ${clauses.join(" AND ")} ORDER BY exported DESC, path, start_line LIMIT 2`,
    params,
  );
  // Never guess between duplicate declarations. Callers can retry with the id
  // returned by flow/context or with path + line.
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Edges whose endpoints belong to the same strongly connected component.
 *
 * Discovery parents describe one spanning tree, not the graph: after a
 * diamond reconverges, a real downstream cycle can cross between branches.
 * Tarjan's algorithm classifies the complete reachable edge set without
 * confusing ordinary reconvergence with recursion.
 */
function cycleEdges(nodes: Iterable<string>, adjacency: Map<string, Set<string>>): string[] {
  const known = new Set(nodes);
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  const componentSizes: number[] = [];
  let nextIndex = 0;

  const connect = (node: string): void => {
    indices.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);

    for (const neighbour of adjacency.get(node) ?? []) {
      if (!known.has(neighbour)) continue;
      if (!indices.has(neighbour)) {
        connect(neighbour);
        low.set(node, Math.min(low.get(node)!, low.get(neighbour)!));
      } else if (onStack.has(neighbour)) {
        low.set(node, Math.min(low.get(node)!, indices.get(neighbour)!));
      }
    }

    if (low.get(node) !== indices.get(node)) return;
    const id = componentSizes.length;
    let size = 0;
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.set(member, id);
      size++;
      if (member === node) break;
    }
    componentSizes.push(size);
  };

  for (const node of known) {
    if (!indices.has(node)) connect(node);
  }

  const cyclic: string[] = [];
  for (const [from, neighbours] of adjacency) {
    const id = component.get(from);
    if (id === undefined) continue;
    for (const to of neighbours) {
      if (component.get(to) !== id) continue;
      if ((componentSizes[id] ?? 0) > 1 || from === to) cyclic.push(`${from} → ${to}`);
    }
  }
  return cyclic.sort();
}

export function trace(
  db: Db,
  symbol: string,
  options: {
    direction?: "callees" | "callers";
    depth?: number;
    path?: string;
    line?: number;
    symbolId?: string;
    maxNodes?: number;
  } = {},
): TraceResult {
  const direction = options.direction ?? "callees";
  const maxDepth = Math.min(options.depth ?? 4, 10);
  const maxNodes = options.maxNodes ?? 200;

  const root = locate(db, symbol, options);
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

  const seen = new Map<string, TraceNode>();
  const leaves: string[] = [];
  let hitNodeCap = false;
  const parents = new Map<string, string>();
  const adjacency = new Map<string, Set<string>>();

  seen.set(root.id, {
    id: root.id,
    symbol: root.symbol,
    path: root.path,
    kind: root.kind,
    line: root.line,
    depth: 0,
    via: null,
    truncated: false,
  });

  let frontier: Array<SymbolRow & { depth: number }> = [{ ...root, depth: 0 }];

  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const current of frontier) {
      const neighbours = step(db, current.id, direction);
      if (current.depth >= maxDepth) {
        const node = seen.get(current.id);
        if (neighbours.length > 0) {
          if (node) node.truncated = true;
        } else {
          leaves.push(current.id);
        }
        continue;
      }

      if (neighbours.length === 0) {
        leaves.push(current.id);
        continue;
      }

      for (const neighbour of neighbours) {
        const id = neighbour.id;
        const outgoing = adjacency.get(current.id) ?? new Set<string>();
        outgoing.add(id);
        adjacency.set(current.id, outgoing);

        if (seen.has(id)) continue;
        if (seen.size >= maxNodes) {
          hitNodeCap = true;
          continue;
        }

        seen.set(id, {
          id,
          symbol: neighbour.symbol,
          path: neighbour.path,
          kind: neighbour.kind,
          line: neighbour.line,
          depth: current.depth + 1,
          via: current.id,
          truncated: false,
        });
        parents.set(id, current.id);
        next.push({ ...neighbour, depth: current.depth + 1 });
      }
    }

    frontier = next;
  }

  const cycles = cycleEdges(seen.keys(), adjacency);

  // Render each leaf back to the root, so the output reads as a path rather
  // than a set of nodes someone has to reassemble.
  const chains: string[] = [];
  const deepest = [...seen.values()].sort((a, b) => b.depth - a.depth);
  const covered = new Set<string>();

  for (const node of deepest) {
    const id = node.id;
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
    root: root.symbol,
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

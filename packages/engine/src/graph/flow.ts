/**
 * The codebase as flow, rather than as clusters.
 *
 * A force-directed graph answers "what is near what". It cannot answer "where
 * does a request start and where does it end up", because that question has a
 * direction and force layouts have none.
 *
 * This lays the call graph out in layers from its entry points — the callable
 * symbols nothing else calls, which in practice are route handlers, CLI
 * commands and exported API. Depth is the longest path from an entry, so a
 * function always appears to the right of everything that reaches it.
 *
 * Shared utilities are the thing that ruins these diagrams: a logger called
 * from forty places drags edges across every layer and turns flow into a
 * hairball. Anything called from enough distinct places is pulled out into a
 * commons lane and its edges are summarised rather than drawn.
 */

import type { Db } from "../db/db.js";

export interface FlowNode {
  id: string;
  symbol: string;
  path: string;
  kind: string;
  line: number;
  /** Longest path from an entry point. Column position. */
  depth: number;
  callers: number;
  callees: number;
  findings: number;
  /** Pulled out of the layers because too many places call it. */
  commons: boolean;
  /** Has callees that were not expanded — clicking it loads more. */
  expandable: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** True when the target sits in the commons lane. */
  toCommons: boolean;
}

export interface FlowView {
  /** Set when the index has no references at all, which is not the same as none existing. */
  note?: string;
  /** Entry points, in the order they should be listed. */
  entries: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Node ids per depth, already ordered to reduce edge crossings. */
  layers: string[][];
  commons: string[];
  truncated: boolean;
  totalCallable: number;
}

const CALLABLE = "('function','method','class')";

/** Called from this many distinct symbols and it stops being part of the flow. */
const COMMONS_THRESHOLD = 6;

interface Row {
  symbol: string;
  path: string;
  kind: string;
  line: number;
}

const idOf = (symbol: string, path: string): string => `${path}#${symbol}`;

/**
 * Callable symbols nothing calls.
 *
 * Tests are excluded on both sides: a test calls production code and is
 * called by nothing, so every test file would otherwise be an entry point —
 * and a direct call *from* a test must not disqualify a handler that nothing
 * in production reaches, or exactly the well-tested entry points vanish.
 */
function entryPoints(db: Db, limit: number): Row[] {
  return db.all<Row>(
    `SELECT s.name AS symbol, s.path, s.kind, s.start_line AS line
     FROM symbols s
     JOIN files f ON f.path = s.path
     WHERE s.kind IN ${CALLABLE}
       AND f.present = 1
       AND f.is_test = 0
       AND NOT EXISTS (
         SELECT 1 FROM refs r
         JOIN files tf ON tf.path = r.src_path
         WHERE r.name = s.name AND r.dst_path = s.path
           AND r.src_symbol IS NOT NULL
           AND tf.is_test = 0
           AND NOT (r.src_path = s.path AND r.src_symbol = s.name)
       )
       AND EXISTS (
         SELECT 1 FROM refs r2
         WHERE r2.src_path = s.path AND r2.src_symbol = s.name AND r2.dst_path IS NOT NULL
       )
     ORDER BY (
       SELECT COUNT(*) FROM refs r3
       WHERE r3.src_path = s.path AND r3.src_symbol = s.name AND r3.dst_path IS NOT NULL
     ) DESC
     LIMIT ?`,
    [limit],
  );
}

function calleesOf(db: Db, symbol: string, path: string): Row[] {
  return db.all<Row>(
    `SELECT DISTINCT s.name AS symbol, s.path, s.kind, s.start_line AS line
     FROM refs r
     JOIN symbols s ON s.path = r.dst_path AND s.name = r.name
     WHERE r.src_path = ? AND r.src_symbol = ? AND r.dst_path IS NOT NULL
       AND s.kind IN ${CALLABLE}
       AND NOT (r.dst_path = r.src_path AND r.name = r.src_symbol)`,
    [path, symbol],
  );
}

function callerCount(db: Db, symbol: string, path: string): number {
  return db.count(
    `SELECT COUNT(DISTINCT r.src_path || '#' || r.src_symbol) AS n FROM refs r
     WHERE r.name = ? AND r.dst_path = ? AND r.src_symbol IS NOT NULL`,
    [symbol, path],
  );
}

export interface FlowOptions {
  /** Start from one symbol instead of every entry point. */
  root?: string;
  rootPath?: string;
  depth?: number;
  maxNodes?: number;
  maxEntries?: number;
}

export function flowView(db: Db, options: FlowOptions = {}): FlowView {
  // No references at all means the call graph was never built — an empty
  // result would read as "this code has no entry points", which is wrong.
  if (db.count("SELECT COUNT(*) AS n FROM refs") === 0) {
    return {
      note: "No references indexed. Run a full scan (audit_scan with full: true) to build the call graph.",
      entries: [],
      nodes: [],
      edges: [],
      layers: [],
      commons: [],
      truncated: false,
      totalCallable: 0,
    };
  }

  const maxDepth = Math.min(options.depth ?? 3, 8);
  // Deliberately small. This is a diagram someone reads, and past roughly
  // this many boxes it scales down to the point where the labels stop being
  // words. Anything larger belongs in the force graph or in `trace`.
  const maxNodes = options.maxNodes ?? 48;
  const maxEntries = options.maxEntries ?? 12;

  const roots: Row[] = options.root
    ? db.all<Row>(
        `SELECT name AS symbol, path, kind, start_line AS line FROM symbols
         WHERE name = ?${options.rootPath ? " AND path = ?" : ""} LIMIT 1`,
        options.rootPath ? [options.root, options.rootPath] : [options.root],
      )
    : entryPoints(db, maxEntries);

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const edgeSeen = new Set<string>();
  let truncated = false;

  const rootIds = new Set(roots.map((row) => idOf(row.symbol, row.path)));

  const add = (row: Row, depth: number): { node: FlowNode; bumped: boolean } => {
    const id = idOf(row.symbol, row.path);
    const existing = nodes.get(id);
    if (existing) {
      // Longest path wins, so a node never sits left of something feeding
      // it. A bump has to propagate — the caller re-enqueues this node so
      // its descendants move right too. Roots stay pinned at zero: a back
      // edge in a cycle would otherwise drag the entry into mid-diagram.
      if (rootIds.has(id) || depth <= existing.depth) {
        return { node: existing, bumped: false };
      }
      existing.depth = depth;
      return { node: existing, bumped: true };
    }
    const node: FlowNode = {
      id,
      symbol: row.symbol,
      path: row.path,
      kind: row.kind,
      line: row.line,
      depth,
      callers: callerCount(db, row.symbol, row.path),
      callees: 0,
      findings: db.count(
        "SELECT COUNT(*) AS n FROM findings WHERE path = ? AND status IN ('open','regressed')",
        [row.path],
      ),
      commons: false,
      expandable: false,
    };
    nodes.set(id, node);
    return { node, bumped: false };
  };

  for (const root of roots) add(root, 0);

  let frontier = roots.map((row) => ({ row, depth: 0 }));
  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const { row, depth } of frontier) {
      const parent = nodes.get(idOf(row.symbol, row.path));
      if (!parent) continue;

      const children = calleesOf(db, row.symbol, row.path);
      parent.callees = children.length;

      if (depth >= maxDepth) {
        parent.expandable = children.length > 0;
        continue;
      }

      for (const child of children) {
        const id = idOf(child.symbol, child.path);
        const edgeKey = `${parent.id}->${id}`;

        if (nodes.size >= maxNodes && !nodes.has(id)) {
          truncated = true;
          parent.expandable = true;
          continue;
        }

        const known = nodes.has(id);
        const { bumped } = add(child, depth + 1);

        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey);
          edges.push({ from: parent.id, to: id, toCommons: false });
        }
        // A bumped node re-enters the frontier so its subtree relaxes to the
        // new depth; the maxDepth guard above bounds this in cyclic graphs.
        if (!known || bumped) next.push({ row: child, depth: depth + 1 });
      }
    }

    frontier = next;
  }

  // Anything called from many distinct places is a utility, not a step in a
  // flow. Marking them keeps their edges out of the layered layout.
  const commons: string[] = [];
  for (const node of nodes.values()) {
    if (node.depth > 0 && node.callers >= COMMONS_THRESHOLD) {
      node.commons = true;
      commons.push(node.id);
    }
  }
  for (const edge of edges) {
    edge.toCommons = nodes.get(edge.to)?.commons ?? false;
  }

  // Layer, then order within each layer by the average position of the things
  // that feed it — one barycenter pass, which removes most crossings cheaply.
  const flowing = [...nodes.values()].filter((node) => !node.commons);
  const depths = flowing.reduce((max, node) => Math.max(max, node.depth), 0);
  const layers: string[][] = Array.from({ length: depths + 1 }, () => []);
  for (const node of flowing) layers[node.depth]?.push(node.id);

  const position = new Map<string, number>();
  layers[0]?.forEach((id, index) => position.set(id, index));

  for (let depth = 1; depth < layers.length; depth++) {
    const layer = layers[depth] ?? [];
    const score = new Map<string, number>();
    for (const id of layer) {
      const parents = edges
        .filter((edge) => edge.to === id && position.has(edge.from))
        .map((edge) => position.get(edge.from) ?? 0);
      score.set(
        id,
        parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : Number.MAX_SAFE_INTEGER,
      );
    }
    layer.sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0));
    layer.forEach((id, index) => position.set(id, index));
  }

  return {
    entries: roots.map((row) => idOf(row.symbol, row.path)),
    nodes: [...nodes.values()],
    edges,
    layers,
    commons,
    truncated,
    totalCallable: db.count(
      `SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.path = s.path
       WHERE s.kind IN ${CALLABLE} AND f.present = 1`,
    ),
  };
}

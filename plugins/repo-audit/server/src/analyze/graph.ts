/**
 * Structural findings derived from the import graph.
 */

import type { Db } from "../db/db.js";
import type { FindingInput } from "../findings/types.js";

const MAX_REPORTED_CYCLES = 20;

/** Tarjan strongly-connected components over resolved import edges. */
export function findCycles(edges: Array<{ src: string; dst: string }>): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const { src, dst } of edges) {
    const list = adjacency.get(src);
    if (list) list.push(dst);
    else adjacency.set(src, [dst]);
  }

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const strongConnect = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      for (;;) {
        const popped = stack.pop()!;
        onStack.delete(popped);
        component.push(popped);
        if (popped === node) break;
      }
      if (component.length > 1) components.push(component.sort());
    }
  };

  for (const node of adjacency.keys()) {
    if (!index.has(node)) strongConnect(node);
  }

  return components.sort((a, b) => b.length - a.length);
}

export function analyzeGraph(db: Db): FindingInput[] {
  const edges = db
    .all<{ src_path: string; dst_path: string }>(
      "SELECT src_path, dst_path FROM edges WHERE dst_path IS NOT NULL",
    )
    .map((row) => ({ src: row.src_path, dst: row.dst_path }));

  const findings: FindingInput[] = [];

  for (const cycle of findCycles(edges).slice(0, MAX_REPORTED_CYCLES)) {
    findings.push({
      ruleId: "graph/import-cycle",
      category: "maintainability",
      severity: cycle.length > 3 ? "high" : "medium",
      confidence: "definite",
      source: "graph",
      title: `Import cycle across ${cycle.length} files`,
      description: `These files form a dependency cycle: ${cycle.join(" → ")} → ${cycle[0]}.`,
      suggestion:
        "Break the cycle by extracting the shared contract into a module both sides can depend on.",
      path: cycle[0],
      symbol: cycle.join(","),
    });
  }

  return findings;
}

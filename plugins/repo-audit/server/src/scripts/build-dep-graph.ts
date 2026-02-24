/**
 * Build dependency graph from module analysis JSONs.
 *
 * Migrated from scripts/build-dep-graph.sh.
 *
 * Reads sdlc-audit/modules/*.json, builds a module dependency graph,
 * detects direct cycles, and classifies hub/orphan modules.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAllModules } from "../lib/modules.js";
import type { DependencyData, ModuleGraphEntry } from "../lib/types.js";

/**
 * Normalize an internal dependency entry to a string.
 *
 * The LLM can produce internal_dependencies as either plain strings
 * or objects like { path: "..." }, { module: "..." }, or { name: "..." }.
 */
function normalizeDep(dep: string | Record<string, unknown>): string {
  if (typeof dep === "string") return dep;
  return String(
    dep.path ?? dep.module ?? dep.name ?? "unknown",
  );
}

/**
 * Normalize an external dependency entry to a string.
 *
 * External deps may be strings or objects like { name: "axios", version: "^1.6" }.
 */
function normalizeExternalDep(dep: string | Record<string, unknown>): string {
  if (typeof dep === "string") return dep;
  return String(dep.name ?? dep.package ?? "unknown");
}

/**
 * Compute the median of a sorted array of numbers.
 * Uses floor(length/2) for the index of the middle element.
 */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

export interface BuildDepGraphResult {
  data: DependencyData;
  summary: { modules: number; cycles: number; hubs: number };
}

/**
 * Build the dependency graph from module JSONs.
 *
 * @param projectRoot Path to the project root
 * @returns The dependency data, also written to disk
 */
export async function buildDepGraph(
  projectRoot: string,
): Promise<BuildDepGraphResult> {
  const modulesDir = join(projectRoot, "sdlc-audit", "modules");
  const outputDir = join(projectRoot, "sdlc-audit", "data");
  const outputFile = join(outputDir, "dependency-data.json");

  const loaded = await readAllModules(modulesDir);

  const emptyResult: DependencyData = {
    module_graph: {},
    circular_dependencies: [],
    hub_modules: [],
    orphan_modules: [],
    external_dependencies: {},
  };

  if (loaded.length === 0) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputFile, JSON.stringify(emptyResult, null, 2));
    return {
      data: emptyResult,
      summary: { modules: 0, cycles: 0, hubs: 0 },
    };
  }

  // Step 1: Extract deps from each module
  const modules = new Map<
    string,
    { depends_on: string[]; external: string[] }
  >();

  for (const mod of loaded) {
    const name = mod.data.directory ?? "unknown";
    const internalDeps = (mod.data.internal_dependencies ?? [])
      .map(normalizeDep)
      .filter((d) => typeof d === "string" && d !== "");
    const externalDeps = (mod.data.external_dependencies ?? [])
      .map(normalizeExternalDep)
      .filter((d) => typeof d === "string" && d !== "");

    modules.set(name, { depends_on: internalDeps, external: externalDeps });
  }

  // Step 2: Build reverse dependency map (who depends on each module)
  const reverseDeps = new Map<string, string[]>();
  for (const [mod, info] of modules) {
    for (const dep of info.depends_on) {
      const existing = reverseDeps.get(dep);
      if (existing) {
        existing.push(mod);
      } else {
        reverseDeps.set(dep, [mod]);
      }
    }
  }

  // Step 3: Detect direct cycles (A→B and B→A)
  // Dedup with a < b to avoid listing both [a,b,a] and [b,a,b]
  const cycleSet = new Set<string>();
  const cycles: string[][] = [];
  for (const [a, info] of modules) {
    for (const b of info.depends_on) {
      const bInfo = modules.get(b);
      if (bInfo && bInfo.depends_on.includes(a)) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!cycleSet.has(key)) {
          cycleSet.add(key);
          const first = a < b ? a : b;
          const second = a < b ? b : a;
          cycles.push([first, second, first]);
        }
      }
    }
  }

  // Step 4: Compute fan-in for all known modules
  const fanIns = new Map<string, number>();
  for (const mod of modules.keys()) {
    fanIns.set(mod, (reverseDeps.get(mod) ?? []).length);
  }

  // Median fan-in
  const sortedFanIns = [...fanIns.values()].sort((a, b) => a - b);
  const medianFanIn = median(sortedFanIns);

  // Hub threshold: max(median * 2, 2)
  const hubThreshold = Math.max(medianFanIn * 2, 2);

  // Hub modules: fan_in > hub_threshold
  const hubs: string[] = [];
  for (const [mod, fi] of fanIns) {
    if (fi > hubThreshold) {
      hubs.push(mod);
    }
  }

  // Orphan modules: fan_in=0 AND fan_out>0
  const orphans: string[] = [];
  for (const [mod, info] of modules) {
    const fi = fanIns.get(mod) ?? 0;
    if (fi === 0 && info.depends_on.length > 0) {
      orphans.push(mod);
    }
  }

  // Step 5: External dependency inventory (package → using modules)
  const extMap: Record<string, string[]> = {};
  for (const [mod, info] of modules) {
    for (const dep of info.external) {
      if (!extMap[dep]) {
        extMap[dep] = [];
      }
      extMap[dep].push(mod);
    }
  }

  // Step 6: Build module graph
  const moduleGraph: Record<string, ModuleGraphEntry> = {};
  for (const [mod, info] of modules) {
    moduleGraph[mod] = {
      depends_on: info.depends_on,
      depended_on_by: reverseDeps.get(mod) ?? [],
      fan_in: fanIns.get(mod) ?? 0,
      fan_out: info.depends_on.length,
      external_deps: info.external,
    };
  }

  const result: DependencyData = {
    module_graph: moduleGraph,
    circular_dependencies: cycles,
    hub_modules: hubs,
    orphan_modules: orphans,
    external_dependencies: extMap,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, JSON.stringify(result, null, 2));

  return {
    data: result,
    summary: {
      modules: Object.keys(moduleGraph).length,
      cycles: cycles.length,
      hubs: hubs.length,
    },
  };
}

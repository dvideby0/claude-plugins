/**
 * Shared utilities for reading module JSON files from the audit directory.
 *
 * Multiple migrated scripts need to glob sdlc-audit/modules/*.json and parse
 * them. This module centralizes that logic with proper typing.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModuleJson } from "./types.js";

export interface LoadedModule {
  /** The parsed module data. */
  data: ModuleJson;
  /** Absolute path to the JSON file. */
  filePath: string;
  /** Filename without directory (e.g. "src_api.json"). */
  fileName: string;
}

/**
 * Read all module JSON files from a directory.
 *
 * Skips files that are not valid JSON or that fail to parse.
 * Returns modules in filename-sorted order for determinism.
 */
export async function readAllModules(
  modulesDir: string,
): Promise<LoadedModule[]> {
  let entries: string[];
  try {
    entries = await readdir(modulesDir);
  } catch {
    return [];
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  const modules: LoadedModule[] = [];

  for (const fileName of jsonFiles) {
    const filePath = join(modulesDir, fileName);
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as ModuleJson;
      modules.push({ data, filePath, fileName });
    } catch {
      // Skip files that aren't valid JSON
    }
  }

  return modules;
}

/**
 * Read a single module JSON by filename.
 */
export async function readModuleByName(
  modulesDir: string,
  name: string,
): Promise<ModuleJson | null> {
  const fileName = name.endsWith(".json") ? name : `${name}.json`;
  const filePath = join(modulesDir, fileName);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as ModuleJson;
  } catch {
    return null;
  }
}

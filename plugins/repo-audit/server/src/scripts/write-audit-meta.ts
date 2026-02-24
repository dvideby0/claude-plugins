/**
 * Write audit metadata for incremental mode support.
 *
 * Migrated from scripts/write-audit-meta.sh.
 *
 * Writes .audit-meta.json with timestamp, audit type, git SHA,
 * plugin version, detection hash, and module list.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runScript } from "../lib/subprocess.js";
import type { AuditMeta } from "../lib/types.js";

/**
 * Compute a deterministic hash of the detection directory classification.
 *
 * Extracts key/category/languages from each directory entry,
 * sorts by key, and produces a SHA-256 hex digest.
 */
function computeDetectionHash(detectionData: Record<string, unknown>): string {
  const allDirs = (detectionData.all_directories ?? {}) as Record<
    string,
    { category?: string; languages?: string[] }
  >;

  const entries = Object.entries(allDirs)
    .map(([key, val]) => ({
      key,
      category: val.category ?? "",
      languages: val.languages ?? [],
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Deterministic JSON for consistent hashing
  const canonical = JSON.stringify(entries);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface WriteAuditMetaOptions {
  projectRoot: string;
  auditType?: string;
  pluginRoot?: string;
  modules?: string[];
}

/**
 * Write audit metadata JSON.
 *
 * @returns The written AuditMeta object.
 */
export async function writeAuditMeta(
  options: WriteAuditMetaOptions,
): Promise<AuditMeta> {
  const {
    projectRoot,
    auditType = "full",
    pluginRoot = "",
    modules = [],
  } = options;

  const outputDir = join(projectRoot, "sdlc-audit", "data");
  const outputFile = join(outputDir, ".audit-meta.json");

  await mkdir(outputDir, { recursive: true });

  // Timestamp
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Git SHA
  let gitSha: string | null = null;
  try {
    const result = await runScript("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      timeout: 10_000,
    });
    const sha = result.stdout.trim();
    if (sha) gitSha = sha;
  } catch {
    // Not a git repo or git not available
  }

  // Plugin version
  let pluginVersion: string | null = null;
  if (pluginRoot) {
    try {
      const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
      const data = await readFile(pluginJsonPath, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed.version) pluginVersion = parsed.version;
    } catch {
      // No plugin.json or invalid
    }
  }

  // Detection hash
  let detectionHash: string | null = null;
  try {
    const detectionPath = join(outputDir, "detection.json");
    const data = await readFile(detectionPath, "utf-8");
    const detection = JSON.parse(data);
    detectionHash = computeDetectionHash(detection);
  } catch {
    // No detection.json
  }

  const meta: AuditMeta = {
    last_audit: timestamp,
    last_audit_type: auditType,
    modules_analyzed: modules,
    total_modules: modules.length,
    git_sha: gitSha,
    plugin_version: pluginVersion,
    detection_hash: detectionHash,
  };

  await writeFile(outputFile, JSON.stringify(meta, null, 2));

  return meta;
}

/**
 * Git history analysis — produces hotspot data and bus factor analysis.
 *
 * Migrated from scripts/git-analysis.sh.
 *
 * Spawns `git` via subprocess and parses stdout in TypeScript instead of
 * piping through grep | sort | uniq -c | sort -rn | head | awk.
 *
 * Always succeeds (returns gracefully if not a git repo or on errors).
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { runScript } from "../lib/subprocess.js";
import type { GitHotspot, GitAnalysisResult } from "../lib/types.js";

/**
 * Run git history analysis on a project root.
 *
 * Produces:
 *   - sdlc-audit/data/git-hotspots.txt  (JSON with hotspot array)
 *   - sdlc-audit/data/git-busfactor.txt (human-readable bus factor)
 */
export async function runGitAnalysis(
  projectRoot: string,
): Promise<GitAnalysisResult> {
  // Check if this is a git repository
  try {
    await access(join(projectRoot, ".git"));
  } catch {
    return { hotspotsWritten: false, busfactorWritten: false };
  }

  const outputDir = join(projectRoot, "sdlc-audit", "data");
  await mkdir(outputDir, { recursive: true });

  let hotspotsWritten = false;
  let busfactorWritten = false;

  // --- Hotspots: most-changed files in last 6 months ---
  try {
    const result = await runScript(
      "git",
      ["log", "--format=format:", "--name-only", "--since=6 months ago"],
      { cwd: projectRoot, timeout: 30_000 },
    );

    const lines = result.stdout.split("\n").filter((l) => l.trim() !== "");

    // Count occurrences of each file
    const counts = new Map<string, number>();
    for (const file of lines) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }

    // Sort by count descending, take top 30
    const hotspots: GitHotspot[] = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([file, changes]) => ({ changes, file }));

    const hotspotsJson = JSON.stringify({ hotspots }, null, 2);
    await writeFile(join(outputDir, "git-hotspots.txt"), hotspotsJson);
    hotspotsWritten = true;
  } catch {
    // git log failed — non-fatal
  }

  // --- Bus factor: contributors per top-level directory ---
  try {
    const lines: string[] = ["=== BUS FACTOR ==="];

    // Get top-level directories (excluding .git, node_modules, sdlc-audit)
    const result = await runScript(
      "git",
      ["ls-tree", "--name-only", "HEAD"],
      { cwd: projectRoot, timeout: 10_000 },
    );

    const topLevelEntries = result.stdout
      .split("\n")
      .filter((e) => e.trim() !== "")
      .filter((e) => !["node_modules", ".git", "sdlc-audit"].includes(e))
      .sort();

    for (const entry of topLevelEntries) {
      lines.push(`--- ${entry} ---`);
      try {
        const shortlogResult = await runScript(
          "git",
          ["shortlog", "-sn", "HEAD", "--", entry],
          { cwd: projectRoot, timeout: 10_000 },
        );
        // Take top 3 contributors
        const contributors = shortlogResult.stdout
          .split("\n")
          .filter((l) => l.trim() !== "")
          .slice(0, 3);
        lines.push(...contributors);
      } catch {
        // Skip this directory on error
      }
    }

    // Recent commit count
    let commitCount = "0";
    try {
      const countResult = await runScript(
        "git",
        ["rev-list", "--count", "--since=6 months ago", "HEAD"],
        { cwd: projectRoot, timeout: 10_000 },
      );
      commitCount = countResult.stdout.trim() || "0";
    } catch {
      // Default to 0
    }

    lines.push("");
    lines.push(`Total commits (6mo): ${commitCount}`);

    await writeFile(join(outputDir, "git-busfactor.txt"), lines.join("\n"));
    busfactorWritten = true;
  } catch {
    // Bus factor analysis failed — non-fatal
  }

  return { hotspotsWritten, busfactorWritten };
}

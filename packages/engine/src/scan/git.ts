/**
 * Git-derived signals. Absent or failed git is not an error — churn just
 * stays zero and risk ranking falls back to structure alone.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../lib/exec.js";

export interface GitInfo {
  available: boolean;
  sha: string | null;
  churn: Map<string, number>;
  /**
   * Renames Git already knows about, new path to old path.
   *
   * Git detects these reliably and this repository has parsed them from
   * porcelain output since change-aware retrieval landed — they just never
   * reached the index, so a `git mv` still looked like a delete plus an add.
   */
  renames: Map<string, string>;
}

export async function collectGit(
  projectRoot: string,
  since = "6 months ago",
  signal?: AbortSignal,
): Promise<GitInfo> {
  const empty: GitInfo = {
    available: false,
    sha: null,
    churn: new Map(),
    renames: new Map(),
  };

  try {
    await access(join(projectRoot, ".git"));
  } catch {
    return empty;
  }

  const head = await exec("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    timeout: 10_000,
    signal,
  });
  if (head.spawnFailed) return empty;

  const sha = head.exitCode === 0 ? head.stdout.trim() || null : null;

  // quotePath off: without it non-ASCII filenames arrive quoted and
  // octal-escaped, never match the walker's UTF-8 paths, and their churn
  // silently reads as zero.
  const log = await exec(
    "git",
    ["-c", "core.quotePath=false", "log", "--format=format:", "--name-only", `--since=${since}`],
    { cwd: projectRoot, timeout: 30_000, signal },
  );

  const churn = new Map<string, number>();
  if (log.exitCode === 0 && !log.timedOut) {
    for (const line of log.stdout.split("\n")) {
      const file = line.trim();
      if (!file) continue;
      churn.set(file, (churn.get(file) ?? 0) + 1);
    }
  }

  return { available: true, sha, churn, renames: await collectRenames(projectRoot, signal) };
}

/**
 * Renames in the working tree, new path to old path.
 *
 * Git's own similarity detection decides what counts as a rename, which is
 * exactly the judgement not worth reimplementing. A failure is not an error:
 * without this signal a move simply behaves as it always has, as a delete and
 * an unrelated add.
 */
async function collectRenames(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const renames = new Map<string, string>();
  const status = await exec(
    "git",
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--find-renames"],
    { cwd: projectRoot, timeout: 15_000, signal },
  );
  if (status.exitCode !== 0 || status.timedOut) return renames;

  for (const line of status.stdout.split("\n")) {
    // `R  old -> new`, with the status code in the first two columns.
    if (!/^R/.test(line.trim()) && !/^.R/.test(line)) continue;
    const separator = line.indexOf(" -> ");
    if (separator < 0) continue;
    const from = line.slice(3, separator).trim();
    const to = line.slice(separator + 4).trim();
    if (from && to) renames.set(to, from);
  }
  return renames;
}

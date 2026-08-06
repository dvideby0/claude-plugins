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
}

export async function collectGit(
  projectRoot: string,
  since = "6 months ago",
  signal?: AbortSignal,
): Promise<GitInfo> {
  const empty: GitInfo = { available: false, sha: null, churn: new Map() };

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

  return { available: true, sha, churn };
}

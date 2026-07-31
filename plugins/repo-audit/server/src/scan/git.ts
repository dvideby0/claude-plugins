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
  });
  if (head.spawnFailed) return empty;

  const sha = head.exitCode === 0 ? head.stdout.trim() || null : null;

  const log = await exec(
    "git",
    ["log", "--format=format:", "--name-only", `--since=${since}`],
    { cwd: projectRoot, timeout: 30_000 },
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

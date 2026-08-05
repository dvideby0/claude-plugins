/**
 * Finding a running daemon, and proving it is actually alive.
 *
 * A stale daemon.json is the normal case after a crash or a hard kill, so
 * every read verifies the pid before trusting the file.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { daemonFile } from "./paths.js";
import type { DaemonInfo } from "./types.js";

/** True when a process with this pid exists and we may signal it. */
export function pidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the running daemon's connection details, or null if there is none.
 * Removes the file when it points at a dead process.
 */
export async function readDaemon(): Promise<DaemonInfo | null> {
  let parsed: DaemonInfo;
  try {
    parsed = JSON.parse(await readFile(daemonFile(), "utf-8")) as DaemonInfo;
  } catch {
    return null;
  }

  if (
    typeof parsed?.pid !== "number" ||
    typeof parsed?.port !== "number" ||
    typeof parsed?.token !== "string"
  ) {
    // A partial file would produce "Bearer undefined" requests downstream.
    return null;
  }
  if (!pidAlive(parsed.pid)) {
    // Re-read before deleting: between our read and now, a freshly started
    // daemon may have replaced the stale file, and deleting *that* leaves a
    // running engine undiscoverable — every consumer then spawns a rival.
    try {
      const current = JSON.parse(await readFile(daemonFile(), "utf-8")) as DaemonInfo;
      if (current?.pid === parsed.pid) await rm(daemonFile(), { force: true });
    } catch {
      // Already gone, or unreadable — nothing worth deleting.
    }
    return null;
  }
  return parsed;
}

/** Publish this process as the running daemon. Owner-readable only. */
export async function writeDaemon(info: DaemonInfo): Promise<void> {
  await mkdir(dirname(daemonFile()), { recursive: true });
  // Written to the side and renamed: readers must never see a torn file.
  const tmp = `${daemonFile()}.${info.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  await rename(tmp, daemonFile());
}

export async function clearDaemon(): Promise<void> {
  await rm(daemonFile(), { force: true });
}

export function baseUrl(info: Pick<DaemonInfo, "port">): string {
  return `http://127.0.0.1:${info.port}`;
}

/** Ask a daemon whether it is answering requests, not merely running. */
export async function ping(info: DaemonInfo, timeoutMs = 2000): Promise<boolean> {
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${baseUrl(info)}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: abort,
    });
    if (!response.ok) return false;
    // Any 200 is not proof of an engine. After a reboot the recorded port
    // can belong to some other local service, and adopting it would hand a
    // foreign page the desktop shell — the reply must look like ours.
    const body = (await response.json()) as { ok?: boolean; version?: string };
    return body?.ok === true && typeof body?.version === "string";
  } catch {
    return false;
  }
}

/** A live, responding daemon — or null. */
export async function findDaemon(): Promise<DaemonInfo | null> {
  const info = await readDaemon();
  if (!info) return null;
  return (await ping(info)) ? info : null;
}

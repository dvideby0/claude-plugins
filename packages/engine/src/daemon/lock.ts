import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";
import { daemonLockDir, pidAlive } from "@sdlc/protocol";

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
  bootTimeMs: number;
}

export interface DaemonLock {
  release(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly ownerPid?: number) {
    super(
      ownerPid
        ? `An engine is already running or starting (pid ${ownerPid}).`
        : "An engine is already starting.",
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerIsValid(value: unknown): value is LockOwner {
  const owner = value as Partial<LockOwner> | null;
  return Boolean(
    owner &&
      typeof owner.pid === "number" &&
      typeof owner.token === "string" &&
      typeof owner.createdAt === "string" &&
      typeof owner.bootTimeMs === "number",
  );
}

function currentBootTimeMs(): number {
  try {
    return Date.now() - uptime() * 1000;
  } catch {
    // Some application sandboxes deny the underlying system uptime query.
    // PID ownership still prevents concurrent writers in that environment;
    // zero simply disables the extra reboot/PID-reuse distinction.
    return 0;
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(path, "owner.json"), "utf-8"));
    return ownerIsValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Acquire machine-wide daemon ownership before opening any shared stores.
 *
 * mkdir and rename are the cross-platform atomic operations used here. A
 * stale lock is renamed to a unique tombstone before deletion, so two startup
 * attempts can never delete a newly acquired lock while cleaning up a crash.
 */
export async function acquireDaemonLock(
  path = daemonLockDir(),
): Promise<DaemonLock> {
  const token = randomBytes(16).toString("hex");
  const owner: LockOwner = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
    bootTimeMs: currentBootTimeMs(),
  };

  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existing = await readOwner(path);
      const sameBoot =
        existing && Math.abs(existing.bootTimeMs - currentBootTimeMs()) < 60_000;
      if (existing && sameBoot && pidAlive(existing.pid)) {
        throw new DaemonAlreadyRunningError(existing.pid);
      }

      // mkdir may have completed just before its owner file was written. Give
      // that tiny window time to settle before declaring an empty lock stale.
      if (!existing && attempt < 10) {
        await pause(25);
        continue;
      }

      const tombstone = `${path}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        await rename(path, tombstone);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      await rm(tombstone, { recursive: true, force: true });
      continue;
    }

    try {
      await writeFile(join(path, "owner.json"), JSON.stringify(owner, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }

    let released = false;
    return {
      async release(): Promise<void> {
        if (released) return;
        released = true;

        const current = await readOwner(path);
        if (current?.token !== token) return;

        const tombstone = `${path}.released-${token}`;
        try {
          await rename(path, tombstone);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        await rm(tombstone, { recursive: true, force: true });
      },
    };
  }

  throw new DaemonAlreadyRunningError();
}

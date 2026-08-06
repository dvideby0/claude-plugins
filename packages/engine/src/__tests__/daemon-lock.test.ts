import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
} from "../daemon/lock.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("daemon ownership lock", () => {
  it("allows exactly one owner and can be reacquired after release", async () => {
    root = await makeProject({});
    const path = join(root, "daemon.lock");
    const first = await acquireDaemonLock(path);

    await expect(acquireDaemonLock(path)).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );

    await first.release();
    const second = await acquireDaemonLock(path);
    await second.release();
  });

  it("publishes owner metadata atomically before contenders can observe the lock", async () => {
    root = await makeProject({});
    const path = join(root, "daemon.lock");
    let releasePublish!: () => void;
    let candidateReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      candidateReady = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });

    const delayed = acquireDaemonLock(path, {
      beforePublish: () => {
        candidateReady();
        return blocked;
      },
    });
    await ready;

    const winner = await acquireDaemonLock(path);
    releasePublish();
    await expect(delayed).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    await winner.release();
  });

  it("recovers a lock left by a dead process", async () => {
    root = await makeProject({});
    const path = join(root, "daemon.lock");
    await mkdir(path);
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale", createdAt: "old" }),
    );

    const lock = await acquireDaemonLock(path);
    await lock.release();
  });

  it("recovers a stale Windows lock when directory publication reports EPERM", async () => {
    root = await makeProject({});
    const path = join(root, "daemon.lock");
    await mkdir(path);
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        token: "stale",
        createdAt: "old",
        bootTimeMs: 1234,
      }),
    );

    let simulatedCollision = false;
    const lock = await acquireDaemonLock(path, {
      platform: "win32",
      bootTimeMs: () => 1234,
      renamePath: async (source, destination) => {
        if (!simulatedCollision && source.includes(".candidate-") && destination === path) {
          simulatedCollision = true;
          throw Object.assign(new Error("Windows target collision"), { code: "EPERM" });
        }
        await rename(source, destination);
      },
    });

    expect(simulatedCollision).toBe(true);
    await lock.release();
  });

  it("keeps an old live lock when a health check would time out", async () => {
    root = await makeProject({});
    const path = join(root, "daemon.lock");
    await mkdir(path);
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "owner-from-crashed-engine",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        bootTimeMs: 1234,
      }),
    );

    await expect(
      acquireDaemonLock(path, {
        bootTimeMs: () => 1234,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it("reclaims a same-boot lock after its pid was reused", async () => {
    root = await makeProject({});
    const path = join(root, "daemon.lock");
    await mkdir(path);
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "owner-from-dead-engine",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        bootTimeMs: 1234,
        processIdentity: "old-process-start",
      }),
    );

    const lock = await acquireDaemonLock(path, {
      bootTimeMs: () => 1234,
      processIdentity: async () => "reused-pid-new-process-start",
    });
    await lock.release();
  });
});

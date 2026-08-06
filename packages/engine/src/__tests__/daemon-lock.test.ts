import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
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
});

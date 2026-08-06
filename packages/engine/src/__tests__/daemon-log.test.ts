import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDaemonLog, safeStreamWriter } from "../daemon/log.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("daemon logging", () => {
  it("rotates at a fixed bound and keeps both files private", async () => {
    root = await makeProject({});
    const path = join(root, "daemon.log");
    const log = openDaemonLog(path, 32);
    log.write("a".repeat(24));
    log.write("b".repeat(16));
    log.close();

    expect(await readFile(`${path}.1`, "utf-8")).toBe("a".repeat(24));
    expect(await readFile(path, "utf-8")).toBe("b".repeat(16));
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
    }
  });

  it("drops a legacy runaway log instead of retaining it as a huge backup", async () => {
    root = await makeProject({ "daemon.log": "x".repeat(100) });
    const path = join(root, "daemon.log");
    const log = openDaemonLog(path, 32);
    log.write("healthy\n");
    log.close();

    expect(await readFile(path, "utf-8")).toBe("healthy\n");
    await expect(stat(`${path}.1`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops writing when the parent stderr pipe closes", () => {
    class BrokenStream extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      write = vi.fn(() => {
        throw Object.assign(new Error("closed"), { code: "EPIPE" });
      });
    }
    const stream = new BrokenStream();
    const write = safeStreamWriter(stream);

    expect(() => write("first")).not.toThrow();
    expect(() => write("second")).not.toThrow();
    expect(stream.write).toHaveBeenCalledOnce();
  });
});

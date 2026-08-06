import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hasTypedConfigChange, WatchRefreshQueue } from "../daemon/watch-refresh.js";
import { isInterestingChange, WorkspaceWatcher } from "../daemon/watcher.js";

describe("watch refresh queue", () => {
  it("retains changes while a foreground index job is running", async () => {
    let blocked = true;
    const refresh = vi.fn(async () => {});
    const queue = new WatchRefreshQueue({
      blocked: () => blocked,
      refresh,
      onError: vi.fn(),
    });

    queue.enqueue("/repo", ["src/a.ts"]);
    queue.enqueue("/repo", ["src/b.ts", "src/a.ts"]);
    await Promise.resolve();

    expect(refresh).not.toHaveBeenCalled();
    expect(queue.pendingCount("/repo")).toBe(2);

    blocked = false;
    queue.resume("/repo");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith("/repo", ["src/a.ts", "src/b.ts"]));
    expect(queue.pendingCount("/repo")).toBe(0);
  });

  it("runs a second coalesced batch for edits that arrive during refresh", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue({
      blocked: () => false,
      refresh: async (_root, paths) => {
        batches.push(paths);
        if (batches.length === 1) await first;
      },
      onError: vi.fn(),
    });

    queue.enqueue("/repo", ["src/a.ts"]);
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    queue.enqueue("/repo", ["src/b.ts"]);
    releaseFirst();

    await vi.waitFor(() => expect(batches).toEqual([["src/a.ts"], ["src/b.ts"]]));
  });

  it("waits for an active refresh and does not retry it after discard", async () => {
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => active);
    const queue = new WatchRefreshQueue({
      blocked: () => false,
      refresh,
      onError: vi.fn(),
    });

    queue.enqueue("/repo", ["src/a.ts"]);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    let discarded = false;
    const done = queue.discard("/repo").then(() => {
      discarded = true;
    });
    await Promise.resolve();
    expect(discarded).toBe(false);

    release();
    await done;
    queue.resume("/repo");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("ignores late events until a discarded root is explicitly registered", async () => {
    const refresh = vi.fn(async () => {});
    const queue = new WatchRefreshQueue({
      blocked: () => false,
      refresh,
      onError: vi.fn(),
    });

    await queue.discard("/repo");
    queue.enqueue("/repo", ["src/late.ts"]);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();

    queue.register("/repo");
    queue.enqueue("/repo", ["src/new.ts"]);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith("/repo", ["src/new.ts"]));
  });

  it("recognizes compiler configuration changes independent of source parsing", () => {
    expect(hasTypedConfigChange(["tsconfig.json"])).toBe(true);
    expect(hasTypedConfigChange(["packages/api/tsconfig.build.json"])).toBe(true);
    expect(hasTypedConfigChange(["jsconfig.json"])).toBe(true);
    expect(hasTypedConfigChange(["config/base.json"])).toBe(true);
    expect(hasTypedConfigChange(["package.json"])).toBe(true);
    expect(hasTypedConfigChange(["src/app.ts", "README.md"])).toBe(false);
  });

  it("watches recognized dotfiles and configuration without watching noise", () => {
    expect(isInterestingChange(".mcp.json")).toBe(true);
    expect(isInterestingChange(".eslintrc.json")).toBe(true);
    expect(isInterestingChange(".codex/config.toml")).toBe(true);
    expect(isInterestingChange(".github/workflows/review.yml")).toBe(true);
    expect(isInterestingChange(".git/config")).toBe(false);
    expect(isInterestingChange(".DS_Store")).toBe(false);
    expect(isInterestingChange("src/.#app.ts")).toBe(false);
  });

  it("rescans for directory rename events that have no file extension", () => {
    expect(isInterestingChange("src/old", "rename")).toBe(true);
    expect(isInterestingChange("src/new", "rename")).toBe(true);
    expect(isInterestingChange("src/old", "change")).toBe(false);
    expect(isInterestingChange("node_modules/pkg", "rename")).toBe(false);
  });

  it("ignores every generated and vendor directory excluded by scanning", () => {
    for (const directory of [".nuxt", ".svelte-kit", ".tox", "vendor", ".idea", ".vscode"]) {
      expect(isInterestingChange(`${directory}/generated.ts`)).toBe(false);
      expect(isInterestingChange(`${directory}/nested`, "rename")).toBe(false);
    }
  });
});

describe("workspace watcher recovery", () => {
  it("retries a workspace that was temporarily unavailable", async () => {
    let attempts = 0;
    const fake = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher;
    const watcher = new WorkspaceWatcher({
      retryMs: 5,
      log: vi.fn(),
      onChange: vi.fn(),
      watchPath: () => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error("volume absent"), { code: "ENOENT" });
        }
        return fake;
      },
    });

    watcher.sync(["/external/repo"]);
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(watcher.roots).toEqual(["/external/repo"]);
    watcher.stopAll();
  });

  it("cancels a pending retry when the workspace is removed", async () => {
    let attempts = 0;
    const watcher = new WorkspaceWatcher({
      retryMs: 20,
      log: vi.fn(),
      onChange: vi.fn(),
      watchPath: () => {
        attempts++;
        throw Object.assign(new Error("volume absent"), { code: "ENOENT" });
      },
    });

    watcher.sync(["/external/repo"]);
    watcher.sync([]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(attempts).toBe(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { hasTypedConfigChange, WatchRefreshQueue } from "../daemon/watch-refresh.js";
import { isInterestingChange } from "../daemon/watcher.js";

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
});

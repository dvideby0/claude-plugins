import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasTypedConfigChange, WatchRefreshQueue } from "../daemon/watch-refresh.js";
import { isInterestingChange, WorkspaceWatcher } from "../daemon/watcher.js";
import { cleanup, makeProject } from "./helpers.js";

/**
 * The watcher asks the repository input policy about paths relative to a root.
 * These cases exercise path-shape rules only, so a root with no `.gitignore`
 * keeps them independent of any fixture on disk.
 */
const watchRoot = "/watch-policy-fixture";

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

  it("watches indexed dotfiles and configuration without watching hidden local state", () => {
    expect(isInterestingChange(watchRoot, ".mcp.json")).toBe(true);
    expect(isInterestingChange(watchRoot, ".eslintrc.json")).toBe(true);
    expect(isInterestingChange(watchRoot, ".claude/settings.local.json")).toBe(false);
    expect(isInterestingChange(watchRoot, ".cursor/mcp.json")).toBe(false);
    expect(isInterestingChange(watchRoot, ".codex/config.toml")).toBe(false);
    expect(isInterestingChange(watchRoot, ".opencode/config.json")).toBe(false);
    expect(isInterestingChange(watchRoot, ".github/workflows/review.yml")).toBe(true);
    expect(isInterestingChange(watchRoot, ".git/config")).toBe(false);
    expect(isInterestingChange(watchRoot, ".DS_Store")).toBe(false);
    expect(isInterestingChange(watchRoot, "src/.#app.ts")).toBe(false);
  });

  it("rescans for directory rename events that have no file extension", () => {
    expect(isInterestingChange(watchRoot, "src/old", "rename")).toBe(true);
    expect(isInterestingChange(watchRoot, "src/new", "rename")).toBe(true);
    expect(isInterestingChange(watchRoot, "src/old", "change")).toBe(false);
    expect(isInterestingChange(watchRoot, "node_modules/pkg", "rename")).toBe(false);
  });

  it("ignores every generated and vendor directory excluded by scanning", () => {
    for (const directory of [".nuxt", ".svelte-kit", ".tox", "vendor", ".idea", ".vscode"]) {
      expect(isInterestingChange(watchRoot, `${directory}/generated.ts`)).toBe(false);
      expect(isInterestingChange(watchRoot, `${directory}/nested`, "rename")).toBe(false);
    }
  });

  it("does not rescan for lockfiles, which are inventory but never evidence", () => {
    // These churn on every install. Refreshing on them would re-walk the whole
    // repository to learn nothing.
    expect(isInterestingChange(watchRoot, "package-lock.json")).toBe(false);
    expect(isInterestingChange(watchRoot, "pnpm-lock.yaml")).toBe(false);
    expect(isInterestingChange(watchRoot, "web/app.min.js")).toBe(false);
  });
});

describe("watcher and scan share one input policy", () => {
  let root: string;
  afterEach(async () => {
    if (root) await cleanup(root);
  });

  it("skips packaged output but still rescans when the policy itself changes", async () => {
    root = await makeProject({
      ".gitignore": "release/\n",
      "src/app.ts": "export const app = 1;\n",
      "release/mac-arm64/App.app/Contents/Resources/app/preload.cjs": "// packaged\n",
    });

    expect(isInterestingChange(root, "src/app.ts")).toBe(true);
    expect(
      isInterestingChange(root, "release/mac-arm64/App.app/Contents/Resources/app/preload.cjs"),
    ).toBe(false);

    // `.gitignore` is never indexed, but editing it changes which files are.
    // A watcher that ignored it would leave the inventory stale until the next
    // manual scan.
    expect(isInterestingChange(root, ".gitignore")).toBe(true);
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

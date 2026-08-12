/**
 * Keeping the index current.
 *
 * A daemon whose index is only as fresh as the last manual run is just a
 * server. This watches every registered workspace and re-indexes what changed,
 * so by the time an agent asks, the answer is already right.
 *
 * Changes are debounced hard: editors write temp files, formatters rewrite
 * whole directories, and a branch switch touches thousands of paths. Reacting
 * to each one would cost far more than waiting for the storm to pass.
 */

import { watch, type FSWatcher } from "node:fs";
import { sourcePathPolicy } from "../scan/source.js";

export interface WatcherOptions {
  /** Quiet period before re-indexing. */
  debounceMs?: number;
  /** Delay before retrying a temporarily unavailable workspace. */
  retryMs?: number;
  /** Test seam for filesystem availability failures. */
  watchPath?: (
    root: string,
    options: { recursive: boolean; persistent: boolean },
  ) => FSWatcher;
  onChange: (root: string, changed: number, paths: string[]) => void;
  log: (message: string) => void;
}

function interesting(relative: string, event: "rename" | "change" = "change"): boolean {
  if (!relative) return false;
  for (const segment of relative.split(/[\\/]/)) {
    // Editor swap and lock files, which change constantly and mean nothing.
    if (segment.startsWith(".#") || segment.endsWith("~")) return false;
  }
  const policy = sourcePathPolicy(relative);
  if (policy.ignored) return false;
  // Root dotfiles such as .mcp.json and .eslintrc.json are indexed inputs.
  // Classification and the ignored-segment list are the boundary; a leading
  // dot by itself is not evidence that a recognized config file is noise.
  // A recursive watcher may report a directory rename only as `src/old` or
  // `src/new`. Directories have no classifiable extension, and the old path no
  // longer exists to stat, so retain every non-noise rename event. The scan is
  // debounced and will cheaply determine whether indexed files really moved.
  return (event === "rename" || policy.language !== "other") && !policy.noise;
}

interface Watched {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  pending: Set<string>;
}

export class WorkspaceWatcher {
  private readonly watched = new Map<string, Watched>();
  private readonly wanted = new Set<string>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly watchPath: NonNullable<WatcherOptions["watchPath"]>;

  constructor(private readonly options: WatcherOptions) {
    this.debounceMs = options.debounceMs ?? 1500;
    this.retryMs = options.retryMs ?? 30_000;
    this.watchPath = options.watchPath ?? ((root, watchOptions) => watch(root, watchOptions));
  }

  get roots(): string[] {
    return [...this.watched.keys()];
  }

  /**
   * Recursive watching is not available everywhere. Where it is missing this
   * logs once and carries on unwatched rather than falling back to polling a
   * whole repository, which costs more than it saves.
   */
  start(root: string): void {
    this.wanted.add(root);
    this.tryStart(root);
  }

  private tryStart(root: string): void {
    if (!this.wanted.has(root) || this.watched.has(root) || this.retries.has(root)) return;

    let watcher: FSWatcher;
    try {
      watcher = this.watchPath(root, { recursive: true, persistent: false });
    } catch (error) {
      this.options.log(
        `not watching ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleRetry(root, error);
      return;
    }

    const entry: Watched = { watcher, timer: null, pending: new Set() };

    watcher.on("error", (error) => {
      this.options.log(`watch error on ${root}: ${error.message}`);
      this.close(root);
      this.scheduleRetry(root, error);
    });

    watcher.on("change", (event, filename) => {
      if (!filename) return;
      const relative = typeof filename === "string" ? filename : filename.toString();
      if (!interesting(relative, event === "rename" ? "rename" : "change")) return;

      entry.pending.add(relative);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        const paths = [...entry.pending];
        entry.pending.clear();
        entry.timer = null;
        this.options.onChange(root, paths.length, paths);
      }, this.debounceMs);
      entry.timer.unref();
    });

    this.watched.set(root, entry);
    this.options.log(`watching ${root}`);
  }

  private close(root: string): void {
    const entry = this.watched.get(root);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    this.watched.delete(root);
  }

  private scheduleRetry(root: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException)?.code;
    // Recursive watching being unsupported is permanent for this platform;
    // retry only failures that can recover when a volume is mounted, access is
    // restored, or an OS watcher resource becomes available again.
    if (
      !this.wanted.has(root) ||
      !["ENOENT", "EACCES", "EPERM", "ESTALE", "EIO", "ENXIO", "ENOSPC"].includes(code ?? "") ||
      this.retries.has(root)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.retries.delete(root);
      this.tryStart(root);
    }, this.retryMs);
    timer.unref();
    this.retries.set(root, timer);
  }

  stop(root: string): void {
    this.wanted.delete(root);
    const retry = this.retries.get(root);
    if (retry) clearTimeout(retry);
    this.retries.delete(root);
    this.close(root);
  }

  /** Bring the watch set in line with the registry. */
  sync(roots: string[]): void {
    const wanted = new Set(roots);
    for (const root of this.wanted) {
      if (!wanted.has(root)) this.stop(root);
    }
    for (const root of wanted) {
      this.wanted.add(root);
      this.tryStart(root);
    }
  }

  stopAll(): void {
    for (const root of [...this.wanted]) this.stop(root);
  }
}

export { interesting as isInterestingChange };

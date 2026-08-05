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
import { basename, sep } from "node:path";
import { classify, isNoise } from "../scan/walk.js";

/** Directories whose churn is never worth reacting to. */
const IGNORED_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "coverage",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".ruff_cache", ".pytest_cache",
  "sdlc-audit", ".turbo", ".cache", ".next", ".parcel-cache",
]);

export interface WatcherOptions {
  /** Quiet period before re-indexing. */
  debounceMs?: number;
  onChange: (root: string, changed: number) => void;
  log: (message: string) => void;
}

function interesting(relative: string): boolean {
  if (!relative) return false;
  for (const segment of relative.split(sep)) {
    if (IGNORED_SEGMENTS.has(segment)) return false;
    // Editor swap and lock files, which change constantly and mean nothing.
    if (segment.startsWith(".#") || segment.endsWith("~")) return false;
  }
  const name = basename(relative);
  if (name.startsWith(".") && !name.startsWith(".github")) return false;
  return classify(relative) !== "other" && !isNoise(relative);
}

interface Watched {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  pending: Set<string>;
}

export class WorkspaceWatcher {
  private readonly watched = new Map<string, Watched>();
  private readonly debounceMs: number;

  constructor(private readonly options: WatcherOptions) {
    this.debounceMs = options.debounceMs ?? 1500;
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
    if (this.watched.has(root)) return;

    let watcher: FSWatcher;
    try {
      watcher = watch(root, { recursive: true, persistent: false });
    } catch (error) {
      this.options.log(
        `not watching ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const entry: Watched = { watcher, timer: null, pending: new Set() };

    watcher.on("error", (error) => {
      this.options.log(`watch error on ${root}: ${error.message}`);
      this.stop(root);
    });

    watcher.on("change", (_event, filename) => {
      if (!filename) return;
      const relative = typeof filename === "string" ? filename : filename.toString();
      if (!interesting(relative)) return;

      entry.pending.add(relative);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        const changed = entry.pending.size;
        entry.pending.clear();
        entry.timer = null;
        this.options.onChange(root, changed);
      }, this.debounceMs);
      entry.timer.unref();
    });

    this.watched.set(root, entry);
    this.options.log(`watching ${root}`);
  }

  stop(root: string): void {
    const entry = this.watched.get(root);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    this.watched.delete(root);
  }

  /** Bring the watch set in line with the registry. */
  sync(roots: string[]): void {
    const wanted = new Set(roots);
    for (const root of this.watched.keys()) {
      if (!wanted.has(root)) this.stop(root);
    }
    for (const root of wanted) this.start(root);
  }

  stopAll(): void {
    for (const root of [...this.watched.keys()]) this.stop(root);
  }
}

export { interesting as isInterestingChange };

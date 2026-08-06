/**
 * Lossless coalescing for filesystem refreshes.
 *
 * A long index or agent-drawing job can overlap many editor events. Those
 * events must wait, not disappear; once the blocker releases, all changed
 * paths are delivered together and changes arriving during that refresh form
 * the next batch.
 */

export interface WatchRefreshOptions {
  blocked: (root: string) => boolean;
  refresh: (root: string, paths: string[]) => Promise<void>;
  onError: (root: string, error: unknown) => void;
}

export class WatchRefreshQueue {
  private readonly pending = new Map<string, Set<string>>();
  private readonly refreshing = new Set<string>();

  constructor(private readonly options: WatchRefreshOptions) {}

  enqueue(root: string, paths: Iterable<string>): void {
    const batch = this.pending.get(root) ?? new Set<string>();
    for (const path of paths) batch.add(path);
    this.pending.set(root, batch);
    this.kick(root);
  }

  /** Re-check a root after the foreground job that blocked it has finished. */
  resume(root: string): void {
    this.kick(root);
  }

  discard(root: string): void {
    this.pending.delete(root);
  }

  pendingCount(root: string): number {
    return this.pending.get(root)?.size ?? 0;
  }

  private kick(root: string): void {
    if (this.refreshing.has(root) || this.options.blocked(root)) return;
    const paths = [...(this.pending.get(root) ?? [])];
    if (paths.length === 0) return;
    this.pending.delete(root);
    this.refreshing.add(root);
    let failed = false;

    void this.options
      .refresh(root, paths)
      .catch((error) => {
        failed = true;
        const retry = this.pending.get(root) ?? new Set<string>();
        for (const path of paths) retry.add(path);
        this.pending.set(root, retry);
        this.options.onError(root, error);
      })
      .finally(() => {
        this.refreshing.delete(root);
        // Avoid a tight failure loop. A new filesystem event or an explicit
        // resume after a foreground job will retry the preserved batch.
        if (!failed) this.kick(root);
      });
  }
}

/**
 * JSON can participate in TypeScript resolution directly (tsconfig/jsconfig),
 * through an arbitrary `extends` filename, or through package metadata.
 */
export function hasTypedConfigChange(paths: Iterable<string>): boolean {
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() ?? "";
    if (/\.json$/i.test(name)) return true;
  }
  return false;
}

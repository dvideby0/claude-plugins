/**
 * The set of repositories this engine knows about.
 *
 * A workspace is registered the first time a tool touches it, so the plugin
 * keeps working without a setup step, and the desktop app can show — and
 * revoke — everything the engine has seen.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { workspacesFile } from "@sdlc/protocol";
import type { Workspace } from "@sdlc/protocol";

function idFor(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

export class WorkspaceRegistry {
  private items = new Map<string, Workspace>();
  private loaded = false;
  /** Serialises writes so concurrent tool calls cannot interleave saves. */
  private writing: Promise<void> = Promise.resolve();

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await readFile(workspacesFile(), "utf-8")) as Workspace[];
      for (const item of raw) this.items.set(item.id, item);
    } catch {
      // No registry yet — the first touch creates it.
    }
    this.loaded = true;
  }

  private save(): Promise<void> {
    // The catch resets the chain: without it, one failed write leaves
    // `writing` permanently rejected and the registry never persists again.
    this.writing = this.writing.catch(() => {}).then(async () => {
      const path = workspacesFile();
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.items.values()], null, 2), { mode: 0o600 });
      await rename(tmp, path);
    });
    return this.writing;
  }

  async list(): Promise<Workspace[]> {
    await this.load();
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Workspace | null> {
    await this.load();
    return this.items.get(id) ?? null;
  }

  /** Register a root, or return the existing entry. */
  async add(root: string): Promise<Workspace> {
    await this.load();
    const absolute = resolve(root);
    const id = idFor(absolute);

    const existing = this.items.get(id);
    if (existing) return existing;

    const workspace: Workspace = {
      id,
      root: absolute,
      name: basename(absolute) || absolute,
      addedAt: new Date().toISOString(),
      lastIndexedAt: null,
    };
    this.items.set(id, workspace);
    await this.save();
    return workspace;
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const removed = this.items.delete(id);
    if (removed) await this.save();
    return removed;
  }

  async markIndexed(root: string): Promise<void> {
    await this.load();
    const workspace = this.items.get(idFor(resolve(root)));
    if (!workspace) return;
    workspace.lastIndexedAt = new Date().toISOString();
    await this.save();
  }

  /**
   * Fire-and-forget registration for the tool path, which is synchronous.
   * Failures here must never fail the tool call that triggered them.
   */
  touch(root: string): void {
    void this.add(root).catch(() => {});
  }
}

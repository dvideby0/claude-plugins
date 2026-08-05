/**
 * The set of repositories this engine knows about.
 *
 * A workspace is registered the first time a tool touches it, so the plugin
 * keeps working without a setup step, and the desktop app can show — and
 * revoke — everything the engine has seen.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { workspacesFile } from "@sdlc/protocol";
import type { Workspace } from "@sdlc/protocol";
import { canonicalWorkspaceRoot, workspaceIdentityKey } from "../lib/workspace-path.js";

function idFor(root: string): string {
  return createHash("sha256").update(workspaceIdentityKey(root)).digest("hex").slice(0, 12);
}

export class WorkspaceRegistry {
  private items = new Map<string, Workspace>();
  private loaded = false;
  /** Serialises writes so concurrent tool calls cannot interleave saves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path = workspacesFile()) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    let changed = false;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf-8")) as Workspace[];
      for (const item of raw) {
        const root = await canonicalWorkspaceRoot(item.root);
        const id = idFor(root);
        const normalized: Workspace = {
          ...item,
          id,
          root,
          name: basename(root) || root,
          generation: Number.isFinite(item.generation) ? item.generation : 0,
        };
        const existing = this.items.get(id);
        if (!existing) {
          this.items.set(id, normalized);
        } else {
          // Old registries can contain both a symlink and its target. Preserve
          // the earliest registration and the newest successful index time.
          const indexed = [existing.lastIndexedAt, normalized.lastIndexedAt]
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? null;
          this.items.set(id, {
            ...existing,
            addedAt:
              existing.addedAt < normalized.addedAt ? existing.addedAt : normalized.addedAt,
            lastIndexedAt: indexed,
            generation: Math.max(existing.generation, normalized.generation),
          });
        }
        changed ||=
          item.id !== id ||
          item.root !== root ||
          !Number.isFinite(item.generation) ||
          Boolean(existing);
      }
    } catch {
      // No registry yet — the first touch creates it.
    }
    this.loaded = true;
    if (changed) await this.save();
  }

  private save(): Promise<void> {
    // The catch resets the chain: without it, one failed write leaves
    // `writing` permanently rejected and the registry never persists again.
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.items.values()], null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
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
    const absolute = await canonicalWorkspaceRoot(root);
    const id = idFor(absolute);

    const existing = this.items.get(id);
    if (existing) return existing;

    const workspace: Workspace = {
      id,
      root: absolute,
      name: basename(absolute) || absolute,
      addedAt: new Date().toISOString(),
      lastIndexedAt: null,
      generation: 0,
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
    const workspace = this.items.get(idFor(await canonicalWorkspaceRoot(root)));
    if (!workspace) return;
    workspace.lastIndexedAt = new Date().toISOString();
    workspace.generation++;
    await this.save();
  }

  /** Signal a completed background enrichment without claiming a new scan. */
  async markUpdated(root: string): Promise<void> {
    await this.load();
    const workspace = this.items.get(idFor(await canonicalWorkspaceRoot(root)));
    if (!workspace) return;
    workspace.generation++;
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

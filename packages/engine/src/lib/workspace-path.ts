import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Resolve aliases to the filesystem's real identity before a workspace gets
 * an id, a scan queue, or a live database handle.
 *
 * A symlink and its target can address the same audit.db. Treating them as two
 * roots creates two in-memory sql.js databases whose flushes overwrite each
 * other. `realpath` also returns canonical casing on case-insensitive hosts.
 */
export async function canonicalWorkspaceRoot(projectRoot: string): Promise<string> {
  const absolute = resolve(projectRoot);
  try {
    return await realpath(absolute);
  } catch {
    // Callers surface the useful "not a directory"/read error later. Keeping a
    // stable lexical fallback also lets status queries describe a missing root.
    return absolute;
  }
}

/** Key form only; preserve canonical display casing in stored Workspace.root. */
export function workspaceIdentityKey(canonicalRoot: string): string {
  return process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
}

/** Resolve an agent-supplied path without letting it escape the workspace. */
export function resolveWorkspacePath(projectRoot: string, path: string): string {
  const root = resolve(projectRoot);
  const target = resolve(root, path);
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return target;
}

/** Read text only when its real path, after symlinks, remains in the workspace. */
export async function readWorkspaceText(
  projectRoot: string,
  path: string,
): Promise<string> {
  const lexical = resolveWorkspacePath(projectRoot, path);
  const [root, target] = await Promise.all([realpath(projectRoot), realpath(lexical)]);
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace through a symlink: ${path}`);
  }
  return readFile(target, "utf-8");
}

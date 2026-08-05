import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

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

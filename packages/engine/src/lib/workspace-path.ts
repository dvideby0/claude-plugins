import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Keep direct reads aligned with the Rust inventory's production file cap. A
// file can grow after indexing, so enforce this while reading rather than
// trusting stale metadata or allocating from the current file size.
const MAX_WORKSPACE_TEXT_BYTES = 2 * 1024 * 1024;

export class WorkspaceTextLimitError extends Error {
  constructor(path: string) {
    super(`${path} exceeds the ${MAX_WORKSPACE_TEXT_BYTES}-byte safe source-read limit.`);
    this.name = "WorkspaceTextLimitError";
  }
}

/**
 * Resolve aliases to the filesystem's real identity before a workspace gets
 * an id, a scan queue, or a live database handle.
 *
 * A symlink and its target can address the same app-owned store. Treating them
 * as two roots would create competing identities. `realpath` also returns
 * canonical casing on case-insensitive hosts.
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

/** Current deterministic workspace id; shared by the registry and store. */
export function workspaceIdForCanonicalRoot(canonicalRoot: string): string {
  return createHash("sha256")
    .update(workspaceIdentityKey(canonicalRoot))
    .digest("hex")
    .slice(0, 12);
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

/** Read bounded text only when its real path, after symlinks, remains in the workspace. */
export async function readWorkspaceText(
  projectRoot: string,
  path: string,
): Promise<string> {
  const lexical = resolveWorkspacePath(projectRoot, path);
  const [root, target] = await Promise.all([realpath(projectRoot), realpath(lexical)]);
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace through a symlink: ${path}`);
  }
  const file = await open(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_WORKSPACE_TEXT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_WORKSPACE_TEXT_BYTES) {
      throw new WorkspaceTextLimitError(path);
    }
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await file.close();
  }
}

export interface WorkspaceSourceSlice {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  characterTruncated: boolean;
  contentSha: string;
  content: string;
}

export type SourceFreshness = "current" | "stale" | "unverified";

/** Hash format shared with the Rust inventory and every source-backed fact. */
export function sourceContentSha(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/**
 * Compare disk source with the revision that produced the selected evidence.
 * `undefined` means the caller is navigating a current index fact; `null`
 * means the producer has no attested source revision, either because the fact
 * predates tracking or because an external process read the live working tree.
 */
export function sourceFreshness(
  currentSha: string,
  indexedSha: string,
  evidenceSha?: string | null,
): SourceFreshness {
  if (evidenceSha === null) return "unverified";
  return currentSha === (evidenceSha ?? indexedSha) ? "current" : "stale";
}

const MAX_SOURCE_SLICE_LINES = 400;
const MAX_SOURCE_SLICE_CHARACTERS = 50_000;

/**
 * Read a bounded source range through the same containment boundary used by
 * the MCP read tool and desktop. Keeping this in one place prevents the UI
 * from growing a second, less careful workspace file reader.
 */
export async function readWorkspaceSourceSlice(
  projectRoot: string,
  path: string,
  startLine = 1,
  endLine = startLine + MAX_SOURCE_SLICE_LINES - 1,
): Promise<WorkspaceSourceSlice> {
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new Error("startLine must be a positive integer.");
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new Error("endLine must be an integer greater than or equal to startLine.");
  }

  const source = await readWorkspaceText(projectRoot, path);
  // Keep scanner-compatible line counting while removing CRLF terminators
  // from individual lines. Passing a raw `\r` through innerHTML makes a
  // Windows source line render as an extra visual newline in the desktop.
  const lines = source.split(/\r?\n/);

  const requestedEnd = endLine;
  const requestedLines = Math.min(MAX_SOURCE_SLICE_LINES, endLine - startLine + 1);
  // Historical evidence can point beyond a shortened current file. Return the
  // last comparably sized current slice so callers can still report staleness
  // and show useful source instead of degrading to "unavailable".
  const actualStart =
    startLine > lines.length ? Math.max(1, lines.length - requestedLines + 1) : startLine;
  let actualEnd = Math.min(lines.length, requestedEnd, actualStart + MAX_SOURCE_SLICE_LINES - 1);
  let content = lines.slice(actualStart - 1, actualEnd).join("\n");
  const characterTruncated = content.length > MAX_SOURCE_SLICE_CHARACTERS;
  if (characterTruncated) {
    content = content.slice(0, MAX_SOURCE_SLICE_CHARACTERS);
    actualEnd = actualStart + content.split("\n").length - 1;
  }

  return {
    path,
    startLine: actualStart,
    endLine: actualEnd,
    totalLines: lines.length,
    truncated: actualEnd < requestedEnd || actualEnd < lines.length || characterTruncated,
    characterTruncated,
    // Match the native scanner's compact persisted signature exactly.
    contentSha: sourceContentSha(source),
    content,
  };
}

import { createHash } from "node:crypto";
import type { Db } from "../db/db.js";

export interface SourceSignatureEntry {
  path: string;
  contentSha: string;
}

/**
 * Stable identity for the exact source inventory represented by an index.
 *
 * Provider snapshots use the same framing in Rust. Length ambiguity is
 * avoided with a NUL between path and content hash and a newline between
 * records; paths are sorted so walker concurrency cannot affect the result.
 */
export function sourceSignature(entries: Iterable<SourceSignatureEntry>): string {
  const hash = createHash("sha256");
  const ordered = [...entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf-8"), Buffer.from(right.path, "utf-8")),
  );
  for (const entry of ordered) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.contentSha);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** Current deterministic index generation, with a fallback for pre-field stores. */
export function indexedSourceSignature(db: Db): string {
  const stored = db.get<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'source_signature'",
  )?.value;
  if (stored) return stored;
  return sourceSignature(
    db
      .all<{ path: string; content_sha: string }>(
        "SELECT path, content_sha FROM files WHERE present = 1 ORDER BY path",
      )
      .map((row) => ({ path: row.path, contentSha: row.content_sha })),
  );
}

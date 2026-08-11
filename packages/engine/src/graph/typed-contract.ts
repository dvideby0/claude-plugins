import { createHash } from "node:crypto";
import type { Db } from "../db/db.js";

/** Marker shared with scanning/projection without loading the TypeScript compiler. */
export const TYPED_SPECIFIER = "typed";

/** Destination identity participates in the existing refs primary key. */
export function typedSpecifier(destination: string, line: number, column: number): string {
  return `${TYPED_SPECIFIER}:${destination}:${line}:${column}`;
}

/** Cheap generation fence shared by compiler facts and their projection. */
export function typedWorkspaceGeneration(db: Db): string {
  const files = db.all<{ path: string; content_sha: string }>(
    "SELECT path, content_sha FROM files WHERE present = 1 ORDER BY path",
  );
  return createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.content_sha}`).join("|"))
    .digest("hex")
    .slice(0, 20);
}

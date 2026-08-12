/**
 * Whether an artifact still describes the code it was written against — and
 * why.
 *
 * Two rules live here so they cannot diverge across the places that ask.
 *
 * The first is what to compare. Anything describing what code *means* compares
 * syntax signatures, so a rewritten comment does not invalidate a component,
 * a flow step, a relation or a memory. Anything anchored to a *line range*
 * keeps comparing content, because inserting a comment really does move those
 * lines, and reporting a stale line number as current is a worse failure than
 * over-invalidating: it is silent.
 *
 * The second is what to say. A bare `stale: true` tells someone their note is
 * suspect but not what happened to it, so every verdict carries a sentence.
 * An index predating syntax signatures cannot answer the question at all, and
 * reports `unverified` rather than borrowing a comparison it did not make.
 */

import type { Db } from "../db/db.js";

/** Same vocabulary as the fact model, plus the case that does not apply. */
export type ArtifactFreshness = "current" | "stale" | "unverified" | "not-applicable";

export interface FreshnessVerdict {
  state: ArtifactFreshness;
  /** One sentence a person can act on. */
  reason: string;
  /** What was actually compared, so the verdict can be audited not trusted. */
  basis: "syntax" | "content" | "absent" | "none";
}

/** The signatures recorded on an artifact when it was written. */
export interface RecordedSignatures {
  contentSha: string | null;
  syntaxSha?: string | null;
}

/** The signatures a file carries now. */
export interface CurrentSignatures {
  present: boolean;
  contentSha: string | null;
  syntaxSha?: string | null;
}

export function currentSignatures(db: Db, path: string): CurrentSignatures {
  const row = db.get<{ present: number; content_sha: string; syntax_sha: string | null }>(
    "SELECT present, content_sha, syntax_sha FROM files WHERE path = ?",
    [path],
  );
  return {
    present: row?.present === 1,
    contentSha: row?.content_sha ?? null,
    syntaxSha: row?.syntax_sha ?? null,
  };
}

/**
 * The comparison an artifact about meaning should make.
 *
 * Falls back to content for files no parser covers, and for stores written
 * before syntax signatures existed — an unverifiable comparison must never
 * read as "unchanged".
 */
export function meaningFreshness(
  path: string,
  recorded: RecordedSignatures,
  current: CurrentSignatures,
): FreshnessVerdict {
  if (!current.present || current.contentSha === null) {
    return {
      state: "stale",
      reason: `${path} is no longer present in the index.`,
      basis: "absent",
    };
  }
  if (recorded.contentSha === null && recorded.syntaxSha == null) {
    return {
      state: "unverified",
      reason: `Nothing was recorded about ${path} when this was written, so it cannot be checked.`,
      basis: "none",
    };
  }

  if (recorded.syntaxSha != null && current.syntaxSha != null) {
    if (recorded.syntaxSha === current.syntaxSha) {
      return recorded.contentSha !== null && recorded.contentSha !== current.contentSha
        ? {
            state: "current",
            reason: `${path} changed, but only in comments or formatting.`,
            basis: "syntax",
          }
        : { state: "current", reason: `${path} is unchanged.`, basis: "syntax" };
    }
    return {
      state: "stale",
      reason: `${path} changed structurally since this was recorded.`,
      basis: "syntax",
    };
  }

  // One side has no syntax signature: an unparsed file type, or an index that
  // predates them. Say which comparison was actually available.
  if (recorded.contentSha === current.contentSha) {
    return {
      state: current.syntaxSha == null ? "current" : "unverified",
      reason:
        current.syntaxSha == null
          ? `${path} is unchanged, compared by content because no parser covers it.`
          : `${path} is unchanged by content, but this was recorded before syntax signatures existed. Re-scan to compare meaning.`,
      basis: "content",
    };
  }
  return {
    state: "stale",
    reason: `${path} changed since this was recorded.`,
    basis: "content",
  };
}

/** The one-call form for the common case. */
export function pathFreshness(
  db: Db,
  path: string,
  recorded: RecordedSignatures,
): FreshnessVerdict {
  return meaningFreshness(path, recorded, currentSignatures(db, path));
}

/**
 * The signature an artifact should record when it is written.
 *
 * Both are stored: syntax decides drift, content stays available for anything
 * that needs the exact revision back.
 */
export function signaturesToRecord(
  db: Db,
  path: string,
): { contentSha: string | null; syntaxSha: string | null } {
  const current = currentSignatures(db, path);
  return { contentSha: current.contentSha, syntaxSha: current.syntaxSha ?? null };
}

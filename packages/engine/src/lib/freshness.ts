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

/** How a file's recorded facts came to be believed. */
export interface EvidenceBasis {
  basis: "read" | "verified" | "sampled" | "unrecorded";
  /** The run that last read the bytes, where that is known. */
  lastReadRun: number | null;
  /** The run that last confirmed the file is still there. */
  lastSeenRun: number | null;
  /** One sentence, in the same voice as a freshness verdict. */
  reason: string;
}

/**
 * Where a file's facts came from, so "unchanged" can be audited.
 *
 * A scan that skips reading a file is making a claim on the filesystem's word
 * rather than on the bytes. That is a good trade, but it is a different kind of
 * evidence, and a fast path nobody can inspect would be a new unexplained
 * source of belief — the thing the input boundary was built to remove.
 */
export function fileEvidenceBasis(db: Db, path: string): EvidenceBasis {
  const row = db.get<{
    freshness_basis: string | null;
    last_read_run: number | null;
    last_seen_run: number | null;
  }>("SELECT freshness_basis, last_read_run, last_seen_run FROM files WHERE path = ?", [path]);

  const lastReadRun = row?.last_read_run ?? null;
  const lastSeenRun = row?.last_seen_run ?? null;
  const at = lastReadRun === null ? "an earlier run" : `run ${lastReadRun}`;

  switch (row?.freshness_basis) {
    case "read":
      return {
        basis: "read",
        lastReadRun,
        lastSeenRun,
        reason: `Its contents were read and hashed at ${at}.`,
      };
    case "verified":
      return {
        basis: "verified",
        lastReadRun,
        lastSeenRun,
        reason:
          `Its contents were read at ${at}. Run ${lastSeenRun} found the filesystem's ` +
          "identity for it — size, inode, modification and change times — unchanged, " +
          "and did not read it again.",
      };
    case "sampled":
      return {
        basis: "sampled",
        lastReadRun,
        lastSeenRun,
        reason:
          `Run ${lastSeenRun} could have skipped this file, and read it anyway to check ` +
          "that the filesystem's identity for it still matches its contents.",
      };
    default:
      return {
        basis: "unrecorded",
        lastReadRun,
        lastSeenRun,
        reason: "This file was indexed before how it was read was recorded.",
      };
  }
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

  // One side has no syntax signature: an unparsed file type, or an artifact
  // recorded before signatures existed. Content is still decisive here, and in
  // one direction it is stronger — identical bytes cannot hide a changed
  // meaning. Reporting that as unverified would make this reader disagree with
  // the planner, the gap queries and the drift comparison, all of which treat
  // equal content as current; two readers contradicting each other about the
  // same artifact is worse than either answer alone.
  if (recorded.contentSha === current.contentSha) {
    return {
      state: "current",
      reason:
        current.syntaxSha == null
          ? `${path} is unchanged, compared by content because no parser covers it.`
          : `${path} is unchanged, compared by content because this was recorded before syntax signatures existed.`,
      basis: "content",
    };
  }
  return {
    state: "stale",
    reason: `${path} changed since this was recorded.`,
    basis: "content",
  };
}

/**
 * Whether two recordings of the same file mean the same thing.
 *
 * Never compares one side's syntax hash against the other's content hash: a
 * store upgraded but not yet rescanned has anchors with no syntax signature
 * and files that already have one, and coalescing the two would report every
 * untouched anchor as changed.
 */
export function sameMeaning(left: RecordedSignatures, right: RecordedSignatures): boolean {
  if (left.syntaxSha != null && right.syntaxSha != null) {
    return left.syntaxSha === right.syntaxSha;
  }
  return left.contentSha !== null && left.contentSha === right.contentSha;
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

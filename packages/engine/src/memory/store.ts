/**
 * What is known about a codebase that reading it will not tell you.
 *
 * Why a dependency was chosen, which invariant is not enforced by types, what
 * was already tried and abandoned. An agent re-derives the code every session
 * whether we help it or not; it cannot re-derive any of this, so it goes in a
 * store and comes back the next time someone touches the same file.
 */

import { createHash } from "node:crypto";
import type { Db } from "../db/db.js";

/**
 * `constraint` is deliberately distinct from `gotcha`: a gotcha is a trap you
 * can walk into, a constraint is a thing that must not be done and why. Agents
 * need the second phrased as a rule, not a warning.
 */
export const MEMORY_KINDS = [
  "decision",
  "convention",
  "constraint",
  "gotcha",
  "context",
  "todo",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Anchor {
  path: string;
  symbol?: string;
}

export interface MemoryInput {
  kind: MemoryKind;
  title: string;
  body?: string;
  anchors?: Anchor[];
  source?: string;
}

export interface Memory {
  id: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  anchors: Array<{ path: string; symbol: string | null; stale: boolean }>;
}

/**
 * Identity is the kind plus the title, so re-recording the same decision
 * updates it instead of accumulating near-duplicates every session.
 */
function fingerprint(kind: string, title: string): string {
  return createHash("sha256")
    .update(`${kind}\0${title.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 20);
}

function currentSha(db: Db, path: string): string | null {
  // Present files only: a deleted file keeps its last row (present = 0), and
  // matching against that old hash made memories about deleted files read as
  // fresh — the "quietly believed" case staleness exists to prevent.
  return (
    db.get<{ content_sha: string }>(
      "SELECT content_sha FROM files WHERE path = ? AND present = 1",
      [path],
    )?.content_sha ?? null
  );
}

export function remember(db: Db, input: MemoryInput): { id: string; created: boolean } {
  const id = fingerprint(input.kind, input.title);
  const now = new Date().toISOString();
  const existing = db.get<{ id: string }>("SELECT id FROM memories WHERE id = ?", [id]);

  if (existing) {
    db.run(
      "UPDATE memories SET body = COALESCE(?, body), updated_at = ?, status = 'active' WHERE id = ?",
      [input.body ?? null, now, id],
    );
  } else {
    db.run(
      `INSERT INTO memories(id, kind, title, body, source, status, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, input.kind, input.title.trim(), input.body ?? "", input.source ?? "agent", now, now],
    );
  }

  // Anchors are replaced wholesale: the caller states where this applies now.
  if (input.anchors) {
    db.run("DELETE FROM memory_anchors WHERE memory_id = ?", [id]);
    for (const anchor of input.anchors) {
      if (!anchor.path) continue;
      db.run(
        "INSERT OR REPLACE INTO memory_anchors(memory_id, path, symbol, content_sha) VALUES(?, ?, ?, ?)",
        [id, anchor.path, anchor.symbol ?? "", currentSha(db, anchor.path)],
      );
    }
  }

  return { id, created: !existing };
}

export function forget(db: Db, id: string, supersededBy?: string): boolean {
  const existing = db.get<{ id: string }>("SELECT id FROM memories WHERE id = ?", [id]);
  if (!existing) return false;
  db.run("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?", [
    supersededBy ?? null,
    new Date().toISOString(),
    id,
  ]);
  return true;
}

function anchorsFor(db: Db, id: string): Memory["anchors"] {
  return db
    .all<{ path: string; symbol: string; content_sha: string | null }>(
      "SELECT path, symbol, content_sha FROM memory_anchors WHERE memory_id = ?",
      [id],
    )
    .map((row) => {
      const current = currentSha(db, row.path);
      return {
        path: row.path,
        symbol: row.symbol || null,
        // The file has moved on — or gone away — since this was written.
        // An anchor recorded before its file was ever indexed has no hash to
        // compare; that is unknown, and unknown must not present as fresh.
        stale: row.content_sha === null || current !== row.content_sha,
      };
    });
}

function hydrate(db: Db, rows: Array<Record<string, unknown>>): Memory[] {
  return rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    title: row.title as string,
    body: row.body as string,
    source: row.source as string,
    status: row.status as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    anchors: anchorsFor(db, row.id as string),
  }));
}

/** Hydrate active memories without losing anchor freshness information. */
export function memoriesByIds(db: Db, ids: readonly string[]): Memory[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return hydrate(
    db,
    db.all(
      `SELECT * FROM memories
       WHERE status = 'active' AND id IN (${placeholders})`,
      [...ids],
    ),
  );
}

export function listMemories(db: Db, kind?: string, limit = 100): Memory[] {
  const rows = kind
    ? db.all(
        "SELECT * FROM memories WHERE status = 'active' AND kind = ? ORDER BY updated_at DESC LIMIT ?",
        [kind, limit],
      )
    : db.all("SELECT * FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?", [
        limit,
      ]);
  return hydrate(db, rows);
}

/** Ranked FTS5 recall over memory titles, bodies, and anchors. */
export function recall(db: Db, query: string, limit = 20, kind?: MemoryKind): Memory[] {
  if (!query.trim()) return listMemories(db, kind, limit);

  const boundedLimit = Number.isFinite(limit)
    ? Math.min(100, Math.max(0, Math.trunc(limit)))
    : 20;
  if (boundedLimit === 0) return [];

  const ranked = db
    .searchKnowledge(query, ["memory"], boundedLimit, { memoryKind: kind })
    .map((hit) => hit.sourceId);
  if (ranked.length === 0) return [];

  const byId = new Map(memoriesByIds(db, ranked).map((memory) => [memory.id, memory]));
  return ranked
    .map((id) => byId.get(id))
    .filter((memory): memory is Memory => Boolean(memory))
    .slice(0, boundedLimit);
}

/** Memories that apply to a file, or to any symbol inside it. */
export function memoriesForPath(db: Db, path: string): Memory[] {
  const rows = db.all(
    `SELECT DISTINCT m.* FROM memories m
     JOIN memory_anchors a ON a.memory_id = m.id
     WHERE m.status = 'active' AND a.path = ?
     ORDER BY m.updated_at DESC`,
    [path],
  );
  return hydrate(db, rows);
}

/**
 * Memories attached to one symbol — a node in the graph, rather than the file
 * that happens to contain it.
 *
 * A rule about `query()` should reach someone editing `query()`, not everyone
 * who opens the 400-line module it lives in. Anchors carry a symbol for
 * exactly this, and looking it up separately is what makes recording against a
 * node worth doing.
 */
export function memoriesForSymbol(db: Db, path: string, symbol: string): Memory[] {
  const rows = db.all(
    `SELECT DISTINCT m.* FROM memories m
     JOIN memory_anchors a ON a.memory_id = m.id
     WHERE m.status = 'active' AND a.path = ? AND a.symbol = ?
     ORDER BY m.updated_at DESC`,
    [path, symbol],
  );
  return hydrate(db, rows);
}

/** Every symbol in this file that carries a memory, with how many. */
export function annotatedSymbols(db: Db, path: string): Map<string, number> {
  const rows = db.all<{ symbol: string; n: number }>(
    `SELECT a.symbol, COUNT(*) AS n FROM memory_anchors a
     JOIN memories m ON m.id = a.memory_id
     WHERE m.status = 'active' AND a.path = ? AND a.symbol != ''
     GROUP BY a.symbol`,
    [path],
  );
  return new Map(rows.map((row) => [row.symbol, row.n]));
}

/** Memories anchored to a symbol name anywhere it is defined. */
export function memoriesForSymbolName(db: Db, symbol: string): Memory[] {
  const rows = db.all(
    `SELECT DISTINCT m.* FROM memories m
     JOIN memory_anchors a ON a.memory_id = m.id
     WHERE m.status = 'active' AND a.symbol = ?
     ORDER BY m.updated_at DESC`,
    [symbol],
  );
  return hydrate(db, rows);
}

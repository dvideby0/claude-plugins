/**
 * The map someone would draw on a whiteboard.
 *
 * The deterministic scan produces a map of the code: every file, every symbol,
 * every edge. It is accurate and almost useless for explaining a system,
 * because nobody explains a system by listing its imports. What a person draws
 * is a few named boxes, arrows with verbs on them, and notes about what
 * matters — an interpretation, not an inventory.
 *
 * This is that interpretation, authored by an agent that read the code and
 * kept the machine graph underneath as evidence. Every box can be expanded
 * back into the files it claims, and every claim carries a count, so the
 * drawing can be checked rather than believed.
 *
 * Coverage is the honest part: files belonging to no component are the parts
 * nobody has explained yet.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { likeEscape } from "../lib/sql.js";

export const COMPONENT_KINDS = [
  "system",
  "service",
  "workflow",
  "layer",
  "module",
  "adapter",
  "store",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

const slug = (name: string): string =>
  createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 12);

/**
 * A fingerprint of what a box currently contains.
 *
 * Covers both the member files and their contents, so it moves when a file
 * inside changes *and* when one is added or deleted. Comparing it to the value
 * stored at drawing time is what makes re-interpretation targeted: the first
 * pass over a repository is expensive, and after that only the boxes whose
 * ground shifted need looking at again.
 */
function memberDigest(db: Db, componentId: string): string {
  const { files } = membersOf(db, componentId);
  const parts = files
    .sort()
    .map(
      (path) =>
        `${path}:${
          db.get<{ content_sha: string }>("SELECT content_sha FROM files WHERE path = ?", [path])
            ?.content_sha ?? ""
        }`,
    );
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20);
}

/** `pattern` is a path or a prefix ending in `/`, matched against files. */
/**
 * What counts as a file on this map.
 *
 * The map describes code, so it is the indexed source files and nothing else.
 * Defined once because it was not: membership matched every present file while
 * coverage counted only source, so a repository of 151 files reported boxes
 * holding 166 — the lockfiles and markdown a prefix happened to sweep up.
 */
const MAPPED_FILES = "present = 1 AND lang IN ('typescript','javascript','python')";

function membersOf(db: Db, componentId: string): { files: string[]; patterns: string[] } {
  const rows = db.all<{ pattern: string; symbol: string }>(
    "SELECT pattern, symbol FROM component_members WHERE component_id = ?",
    [componentId],
  );
  const files = new Set<string>();
  for (const row of rows) {
    const matched = db.all<{ path: string }>(
      `SELECT path FROM files WHERE ${MAPPED_FILES} AND (path = ? OR path LIKE ? ESCAPE '\\')`,
      [row.pattern, `${likeEscape(row.pattern.replace(/\/$/, ""))}/%`],
    );
    for (const file of matched) files.add(file.path);
  }
  return { files: [...files], patterns: rows.map((row) => row.pattern) };
}

export interface ComponentInput {
  name: string;
  summary?: string;
  kind?: ComponentKind;
  /** Parent name; null explicitly moves an existing component to the root. */
  parent?: string | null;
  /** Paths or directory prefixes this box covers. */
  members?: string[];
  /** Existing files deliberately left outside every component. */
  acknowledgeUnassigned?: string[];
  ordinal?: number;
}

function allMappedFiles(db: Db): string[] {
  return db
    .all<{ path: string }>(`SELECT path FROM files WHERE ${MAPPED_FILES} ORDER BY path`)
    .map((row) => row.path);
}

function unassignedFiles(db: Db): string[] {
  const assigned = new Set<string>();
  for (const component of db.all<{ id: string }>("SELECT id FROM components")) {
    for (const path of membersOf(db, component.id).files) assigned.add(path);
  }
  return allMappedFiles(db).filter((path) => !assigned.has(path));
}

function acknowledgeMapFiles(db: Db, paths: Iterable<string>, at: string): void {
  const unassigned = new Set(unassignedFiles(db));
  for (const path of paths) {
    if (!unassigned.has(path)) continue;
    db.run(
      "INSERT OR REPLACE INTO map_file_ack(path, acknowledged_at) VALUES(?, ?)",
      [path, at],
    );
  }
}

export function describeComponent(db: Db, input: ComponentInput): { id: string; created: boolean } {
  const id = slug(input.name);
  const now = new Date().toISOString();
  const parentSpecified = Object.prototype.hasOwnProperty.call(input, "parent");
  const parentId = input.parent ? slug(input.parent) : null;

  if (parentId === id) throw new Error("A component cannot contain itself.");
  if (parentId) {
    let ancestor: string | null = parentId;
    const visited = new Set<string>();
    while (ancestor) {
      if (ancestor === id) throw new Error("A component cannot contain one of its ancestors.");
      if (visited.has(ancestor)) throw new Error("The proposed parent already belongs to a cycle.");
      visited.add(ancestor);
      const parentRow: { parent_id: string | null } | null = db.get(
        "SELECT parent_id FROM components WHERE id = ?",
        [ancestor],
      );
      if (!parentRow) throw new Error(`Unknown parent component "${input.parent}".`);
      ancestor = parentRow.parent_id;
    }
  }

  const existing = db.get<{ id: string }>("SELECT id FROM components WHERE id = ?", [id]);
  if (existing) {
    // Update only what the caller stated. Every field here is authored
    // interpretation; "re-using a name updates it" must not mean a call that
    // adjusts membership silently wipes the summary, re-kinds the box,
    // re-parents it to the root and resets its order.
    db.run(
      `UPDATE components SET
         summary = COALESCE(?, summary),
         kind = COALESCE(?, kind),
         parent_id = CASE WHEN ? = 1 THEN ? ELSE parent_id END,
         ordinal = COALESCE(?, ordinal),
         updated_at = ?
       WHERE id = ?`,
      [
        input.summary ?? null,
        input.kind ?? null,
        parentSpecified ? 1 : 0,
        parentId,
        input.ordinal ?? null,
        now,
        id,
      ],
    );
  } else {
    db.run(
      `INSERT INTO components(id, name, summary, kind, parent_id, ordinal, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.summary ?? "",
        input.kind ?? "module",
        parentId,
        input.ordinal ?? 0,
        now,
        now,
      ],
    );
  }

  if (input.members) {
    db.run("DELETE FROM component_members WHERE component_id = ?", [id]);
    for (const pattern of input.members) {
      db.run(
        "INSERT OR REPLACE INTO component_members(component_id, pattern, symbol) VALUES(?, ?, '')",
        [id, pattern],
      );
    }
  }

  // Only an explicit membership statement acknowledges the current code.
  // Moving a box or editing its prose must not silently clear existing drift.
  if (!existing || input.members !== undefined) {
    db.run("UPDATE components SET member_digest = ? WHERE id = ?", [memberDigest(db, id), id]);

    // Per-file snapshot, so drift can name the files rather than the box.
    db.run("DELETE FROM component_snapshot WHERE component_id = ?", [id]);
    for (const path of membersOf(db, id).files) {
      const sha =
        db.get<{ content_sha: string }>("SELECT content_sha FROM files WHERE path = ?", [path])
          ?.content_sha ?? "";
      db.run(
        "INSERT OR REPLACE INTO component_snapshot(component_id, path, content_sha) VALUES(?, ?, ?)",
        [id, path, sha],
      );
    }
  }

  if (input.acknowledgeUnassigned) {
    acknowledgeMapFiles(db, input.acknowledgeUnassigned, now);
  }

  return { id, created: !existing };
}

/**
 * Commit an authored map only after the drawing pass reaches its explicit end.
 *
 * Creating the first component is not completion: an interrupted agent may
 * still owe the rest of the boxes, every flow and all cross-cutting tags. The
 * marker keeps the next pass in resume mode until the agent calls this tool.
 */
export function finalizeMap(
  db: Db,
  input: { acknowledgeUnassigned?: string[] } = {},
): { complete: true; unassigned: number } {
  if (db.count("SELECT COUNT(*) AS n FROM components") === 0) {
    throw new Error("Cannot finalize an empty map; draw at least one component first.");
  }

  const now = new Date().toISOString();
  if (input.acknowledgeUnassigned) {
    acknowledgeMapFiles(db, input.acknowledgeUnassigned, now);
  }

  const acknowledged = new Set(
    db.all<{ path: string }>("SELECT path FROM map_file_ack").map((row) => row.path),
  );
  const unexplained = unassignedFiles(db).filter((path) => !acknowledged.has(path));
  if (unexplained.length > 0) {
    throw new Error(
      `Map still has ${unexplained.length} unexplained file(s): ${unexplained.slice(0, 10).join(", ")}. ` +
        "Assign them to components or explicitly acknowledge them when finalizing.",
    );
  }

  // Each drawing must advance the marker. A timestamp alone can collide when
  // a fast retry finalizes in the same millisecond, and the draw supervisor
  // uses this value to distinguish new completion from an inherited old flag.
  db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('map_complete', ?)", [
    `${now}:${randomUUID()}`,
  ]);
  return { complete: true, unassigned: unassignedFiles(db).length };
}

export interface FlowStepInput {
  label: string;
  path?: string;
  symbol?: string;
  note?: string;
}

export interface FlowInput {
  name: string;
  summary?: string;
  /** What sets it off — a request, a cron, a message. */
  trigger?: string;
  steps: FlowStepInput[];
}

export function describeFlow(db: Db, input: FlowInput): { id: string; steps: number } {
  if (input.steps.length === 0) {
    throw new Error("A flow needs steps — that is the part a reader came for.");
  }

  const id = slug(input.name);
  const now = new Date().toISOString();
  const existing = db.get<{ id: string }>("SELECT id FROM flows WHERE id = ?", [id]);

  if (existing) {
    db.run(
      `UPDATE flows SET summary = COALESCE(?, summary),
                        trigger = COALESCE(?, trigger), updated_at = ?
       WHERE id = ?`,
      [input.summary ?? null, input.trigger ?? null, now, id],
    );
  } else {
    db.run(
      "INSERT INTO flows(id, name, summary, trigger, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
      [id, input.name.trim(), input.summary ?? "", input.trigger ?? null, now, now],
    );
  }

  // Steps are replaced wholesale: a flow is an ordered whole, and merging
  // would silently interleave an old sequence with a new one.
  db.run("DELETE FROM flow_steps WHERE flow_id = ?", [id]);
  input.steps.forEach((step, index) => {
    const sha = step.path
      ? (db.get<{ content_sha: string }>("SELECT content_sha FROM files WHERE path = ?", [
          step.path,
        ])?.content_sha ?? null)
      : null;
    db.run(
      "INSERT INTO flow_steps(flow_id, ordinal, label, path, symbol, note, content_sha) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [id, index, step.label, step.path ?? null, step.symbol ?? null, step.note ?? null, sha],
    );
  });

  return { id, steps: input.steps.length };
}

export function tagNode(
  db: Db,
  input: { tag: string; path: string; symbol?: string; note?: string; description?: string },
): { tag: string } {
  db.run("INSERT OR IGNORE INTO tags(name, description) VALUES(?, ?)", [
    input.tag,
    input.description ?? "",
  ]);
  if (input.description) {
    db.run("UPDATE tags SET description = ? WHERE name = ?", [input.description, input.tag]);
  }
  db.run("INSERT OR REPLACE INTO node_tags(tag, path, symbol, note) VALUES(?, ?, ?, ?)", [
    input.tag,
    input.path,
    input.symbol ?? "",
    input.note ?? null,
  ]);
  return { tag: input.tag };
}

export interface MapComponent {
  id: string;
  name: string;
  summary: string;
  kind: string;
  parent: string | null;
  patterns: string[];
  fileCount: number;
  /** Symbols inside, so a box has a sense of weight. */
  symbolCount: number;
  openFindings: number;
  tags: string[];
  children: string[];
  /**
   * Counts including every box nested inside this one.
   *
   * A container drawn as a pure grouping owns no files itself, so reporting
   * only its own membership renders the root of a map as "0 files" — true,
   * and the opposite of what it looks like on the page.
   */
  rollupFiles: number;
  rollupSymbols: number;
  /** The files under this box changed after it was drawn. */
  drifted: boolean;
}

export interface MapFlow {
  id: string;
  name: string;
  summary: string;
  trigger: string | null;
  steps: Array<{
    label: string;
    path: string | null;
    symbol: string | null;
    note: string | null;
    /** Which box this step happens in, so a flow can be drawn across them. */
    component: string | null;
    /** False when the step names code that is no longer there. */
    resolves: boolean;
    /** The file changed after this step was written. */
    drifted: boolean;
  }>;
}

export interface SystemMap {
  components: MapComponent[];
  flows: MapFlow[];
  tags: Array<{ name: string; description: string; count: number }>;
  /** Files in no component — the parts nobody has explained yet. */
  coverage: { assigned: number; total: number; percent: number; unassigned: string[] };
  empty: boolean;
}

export interface MapDrift {
  /** False until the first drawing explicitly reaches its final step. */
  complete: boolean;
  components: Array<{ id: string; name: string; changedFiles: string[] }>;
  flows: Array<{ id: string; name: string; steps: string[] }>;
  /** Files belonging to no box — usually code added since the last drawing. */
  newlyUnassigned: string[];
  clean: boolean;
}

/**
 * What needs redrawing, and nothing else.
 *
 * The whole point of storing a digest: after the first pass, an agent should
 * re-read the two files that moved rather than the whole repository.
 */
export function mapDrift(db: Db): MapDrift {
  const map = systemMap(db);

  const components = map.components
    .filter((component) => component.drifted)
    .map((component) => {
      // Diffed against the snapshot taken when the box was drawn: edited,
      // added and removed files each name themselves.
      const drawnAt = new Map(
        db
          .all<{ path: string; content_sha: string }>(
            "SELECT path, content_sha FROM component_snapshot WHERE component_id = ?",
            [component.id],
          )
          .map((row) => [row.path, row.content_sha]),
      );
      const now = new Map(
        membersOf(db, component.id).files.map((path) => [
          path,
          db.get<{ content_sha: string }>("SELECT content_sha FROM files WHERE path = ?", [path])
            ?.content_sha ?? "",
        ]),
      );

      const changedFiles: string[] = [];
      for (const [path, sha] of now) {
        if (!drawnAt.has(path)) changedFiles.push(`${path} (added)`);
        else if (drawnAt.get(path) !== sha) changedFiles.push(path);
      }
      for (const path of drawnAt.keys()) {
        if (!now.has(path)) changedFiles.push(`${path} (removed)`);
      }

      return { id: component.id, name: component.name, changedFiles };
    });

  const flows = map.flows
    .filter((flow) => flow.steps.some((step) => step.drifted || !step.resolves))
    .map((flow) => ({
      id: flow.id,
      name: flow.name,
      steps: flow.steps
        .filter((step) => step.drifted || !step.resolves)
        .map((step) => `${step.label}${step.resolves ? "" : " (file gone)"}`),
    }));

  const acknowledged = new Set(
    db.all<{ path: string }>("SELECT path FROM map_file_ack").map((row) => row.path),
  );
  // Work from the complete set. systemMap intentionally caps its display list,
  // but a presentation cap must never turn a real drift signal into clean.
  const newlyUnassigned = unassignedFiles(db)
    .filter((path) => !acknowledged.has(path))
    .slice(0, 20);

  const complete = Boolean(db.get("SELECT value FROM meta WHERE key = 'map_complete'"));
  return {
    complete,
    components,
    flows,
    newlyUnassigned,
    clean:
      complete &&
      components.length === 0 &&
      flows.length === 0 &&
      newlyUnassigned.length === 0,
  };
}

export function systemMap(db: Db): SystemMap {
  const components = db.all<{
    id: string;
    name: string;
    summary: string;
    kind: string;
    parent_id: string | null;
    ordinal: number;
    member_digest: string | null;
  }>("SELECT * FROM components ORDER BY ordinal, name");

  const assigned = new Set<string>();
  const mapped: MapComponent[] = components.map((component) => {
    const { files, patterns } = membersOf(db, component.id);
    for (const file of files) assigned.add(file);

    const placeholders = files.map(() => "?").join(",");
    return {
      id: component.id,
      name: component.name,
      summary: component.summary,
      kind: component.kind,
      parent: component.parent_id,
      patterns,
      fileCount: files.length,
      symbolCount: files.length
        ? db.count(`SELECT COUNT(*) AS n FROM symbols WHERE path IN (${placeholders})`, files)
        : 0,
      openFindings: files.length
        ? db.count(
            `SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','regressed') AND path IN (${placeholders})`,
            files,
          )
        : 0,
      tags: files.length
        ? db
            .all<{ tag: string }>(
              `SELECT DISTINCT tag FROM node_tags WHERE path IN (${placeholders})`,
              files,
            )
            .map((row) => row.tag)
        : [],
      children: components
        .filter((other) => other.parent_id === component.id)
        .map((other) => other.id),
      rollupFiles: 0,
      rollupSymbols: 0,
      drifted:
        Boolean(component.member_digest) && component.member_digest !== memberDigest(db, component.id),
    };
  });

  // Roll up the tree by unioning file sets rather than summing counts. Boxes
  // are allowed to overlap — a file can be in both "Subject Lookup" and a
  // shared "Core Runtime" — and adding the counts would report more files than
  // the repository contains.
  const byId = new Map(mapped.map((component) => [component.id, component]));
  const ownFiles = new Map(
    mapped.map((component) => [component.id, new Set(membersOf(db, component.id).files)]),
  );
  const rollup = (id: string, seen: Set<string>): Set<string> => {
    if (seen.has(id)) return new Set();
    seen.add(id);
    const component = byId.get(id);
    if (!component) return new Set();
    const files = new Set(ownFiles.get(id));
    for (const childId of component.children) {
      for (const file of rollup(childId, seen)) files.add(file);
    }
    component.rollupFiles = files.size;
    component.rollupSymbols = files.size
      ? db.count(
          `SELECT COUNT(*) AS n FROM symbols WHERE path IN (${[...files].map(() => "?").join(",")})`,
          [...files],
        )
      : 0;
    return files;
  };
  for (const component of mapped) rollup(component.id, new Set());

  // Deepest box wins, the same rule componentOf() applies — the map view and
  // the file view must not attribute one file to two different boxes.
  const depthCache = new Map<string, number>();
  const depthFor = (id: string): number => {
    const memo = depthCache.get(id);
    if (memo !== undefined) return memo;
    let depth = 0;
    for (
      let parent = byId.get(id)?.parent ?? null;
      parent && byId.has(parent) && depth < 10;
      parent = byId.get(parent)?.parent ?? null
    ) {
      depth++;
    }
    depthCache.set(id, depth);
    return depth;
  };
  const componentOfFile = new Map<string, { name: string; depth: number }>();
  for (const component of mapped) {
    const depth = depthFor(component.id);
    for (const file of ownFiles.get(component.id) ?? []) {
      const current = componentOfFile.get(file);
      if (!current || depth > current.depth) {
        componentOfFile.set(file, { name: component.name, depth });
      }
    }
  }

  const flows: MapFlow[] = db
    .all<{ id: string; name: string; summary: string; trigger: string | null }>(
      "SELECT * FROM flows ORDER BY name",
    )
    .map((flow) => ({
      id: flow.id,
      name: flow.name,
      summary: flow.summary,
      trigger: flow.trigger,
      steps: db
        .all<{
          label: string;
          path: string | null;
          symbol: string | null;
          note: string | null;
          content_sha: string | null;
        }>(
          "SELECT label, path, symbol, note, content_sha FROM flow_steps WHERE flow_id = ? ORDER BY ordinal",
          [flow.id],
        )
        .map((step) => ({
          label: step.label,
          path: step.path,
          symbol: step.symbol,
          note: step.note,
          component: step.path ? (componentOfFile.get(step.path)?.name ?? null) : null,
          // A drawing that points at deleted code should say so rather than
          // quietly describing a system that no longer exists.
          resolves: step.path
            ? db.count("SELECT COUNT(*) AS n FROM files WHERE path = ? AND present = 1", [
                step.path,
              ]) > 0
            : true,
          // A missing baseline is stale, not clean. This happens when a flow
          // is authored before the referenced file has been indexed; once the
          // file appears, the claim still needs to be re-read and rewritten.
          drifted: Boolean(
            step.path &&
              (!step.content_sha ||
                step.content_sha !==
                  db.get<{ content_sha: string }>("SELECT content_sha FROM files WHERE path = ?", [
                    step.path,
                  ])?.content_sha),
          ),
        })),
    }));

  const total = db.count(`SELECT COUNT(*) AS n FROM files WHERE ${MAPPED_FILES}`);
  const unassigned = allMappedFiles(db).filter((path) => !assigned.has(path));

  return {
    components: mapped,
    flows,
    tags: db
      .all<{ name: string; description: string }>("SELECT name, description FROM tags ORDER BY name")
      .map((tag) => ({
        ...tag,
        count: db.count("SELECT COUNT(*) AS n FROM node_tags WHERE tag = ?", [tag.name]),
      })),
    coverage: {
      assigned: total - unassigned.length,
      total,
      percent: total ? Math.round(((total - unassigned.length) / total) * 100) : 0,
      unassigned: unassigned.slice(0, 40),
    },
    empty: components.length === 0 && flows.length === 0,
  };
}

export interface ComponentDetail {
  id: string;
  name: string;
  summary: string;
  kind: string;
  patterns: string[];
  /** The machine's view of what sits inside this box. */
  files: Array<{
    path: string;
    loc: number;
    symbols: number;
    fanIn: number;
    openFindings: number;
    tags: string[];
    changed: boolean;
  }>;
  /**
   * Boxes nested inside this one.
   *
   * A grouping box owns no files of its own, so without this the drawer for
   * the root of a map is an empty table — the least useful thing it could show.
   */
  children: Array<{ id: string; name: string; kind: string; summary: string; fileCount: number }>;
  /** Flows that pass through here, so a box links back to the narrative. */
  flows: Array<{ id: string; name: string; steps: string[] }>;
  /** Notes recorded against files in this box. */
  memories: Array<{ id: number; kind: string; title: string; path: string }>;
}

/**
 * One box, opened up.
 *
 * The drawn map is an interpretation; this is the evidence underneath it. Both
 * matter and neither replaces the other — the prose says how something works,
 * the file list says what would actually change if you edited it. Anything
 * claiming to be a map of a codebase needs to let you cross between the two.
 */
export function componentDetail(db: Db, id: string): ComponentDetail | null {
  const component = db.get<{
    id: string;
    name: string;
    summary: string;
    kind: string;
  }>("SELECT id, name, summary, kind FROM components WHERE id = ?", [id]);
  if (!component) return null;

  const children = db
    .all<{ id: string; name: string; kind: string; summary: string }>(
      "SELECT id, name, kind, summary FROM components WHERE parent_id = ? ORDER BY ordinal, name",
      [id],
    )
    .map((child) => ({ ...child, fileCount: membersOf(db, child.id).files.length }));

  const { files, patterns } = membersOf(db, id);
  const drawn = new Map(
    db
      .all<{ path: string; content_sha: string }>(
        "SELECT path, content_sha FROM component_snapshot WHERE component_id = ?",
        [id],
      )
      .map((row) => [row.path, row.content_sha]),
  );

  const detail = files.map((path) => {
    const file = db.get<{ loc: number; content_sha: string }>(
      "SELECT loc, content_sha FROM files WHERE path = ?",
      [path],
    );
    return {
      path,
      loc: file?.loc ?? 0,
      symbols: db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = ?", [path]),
      fanIn: db.count("SELECT COUNT(*) AS n FROM edges WHERE dst_path = ?", [path]),
      openFindings: db.count(
        "SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','regressed') AND path = ?",
        [path],
      ),
      tags: db
        .all<{ tag: string }>("SELECT tag FROM node_tags WHERE path = ?", [path])
        .map((row) => row.tag),
      changed: drawn.has(path) && drawn.get(path) !== (file?.content_sha ?? ""),
    };
  });

  const placeholders = files.map(() => "?").join(",");
  const flows = files.length
    ? db
        .all<{ id: string; name: string }>(
          `SELECT DISTINCT f.id, f.name FROM flows f
           JOIN flow_steps s ON s.flow_id = f.id
           WHERE s.path IN (${placeholders}) ORDER BY f.name`,
          files,
        )
        .map((flow) => ({
          id: flow.id,
          name: flow.name,
          steps: db
            .all<{ label: string }>(
              `SELECT label FROM flow_steps WHERE flow_id = ? AND path IN (${placeholders})
               ORDER BY ordinal`,
              [flow.id, ...files],
            )
            .map((row) => row.label),
        }))
    : [];

  const memories = files.length
    ? db.all<{ id: number; kind: string; title: string; path: string }>(
        `SELECT DISTINCT m.id, m.kind, m.title, a.path FROM memories m
         JOIN memory_anchors a ON a.memory_id = m.id
         WHERE m.status = 'active' AND a.path IN (${placeholders})
         ORDER BY m.id DESC LIMIT 20`,
        files,
      )
    : [];

  return {
    id: component.id,
    name: component.name,
    summary: component.summary,
    kind: component.kind,
    patterns,
    children,
    files: detail.sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path)),
    flows,
    memories,
  };
}

/**
 * Which box a file sits in — the link from the machine index back to the map.
 *
 * Membership is stored as patterns rather than resolved paths, so this has to
 * expand them. Deepest box wins: a file in both "App" and "App / API" belongs
 * to the API, which is what someone reading the map would say.
 */
export function componentOf(db: Db, path: string): { id: string; name: string } | null {
  let best: { id: string; name: string; depth: number } | null = null;
  for (const component of db.all<{ id: string; name: string; parent_id: string | null }>(
    "SELECT id, name, parent_id FROM components ORDER BY ordinal, name",
  )) {
    if (!membersOf(db, component.id).files.includes(path)) continue;
    let depth = 0;
    for (
      let parent = component.parent_id;
      parent && depth < 10;
      parent = db.get<{ parent_id: string | null }>(
        "SELECT parent_id FROM components WHERE id = ?",
        [parent],
      )?.parent_id ?? null
    ) {
      depth++;
    }
    if (!best || depth > best.depth) best = { id: component.id, name: component.name, depth };
  }
  return best ? { id: best.id, name: best.name } : null;
}

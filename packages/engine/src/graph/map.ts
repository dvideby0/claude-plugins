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
import {
  pathFreshness,
  sameMeaning,
  signaturesToRecord,
  type RecordedSignatures,
} from "../lib/freshness.js";

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
/**
 * Recompute a box's aggregates after its members' paths moved.
 *
 * Both are rewritten together: leaving one behind is what turns a rename into
 * permanent drift that names no file.
 */
export function refreshMemberDigests(db: Db, componentId: string): void {
  db.run(
    `UPDATE components
        SET member_digest = ?,
            member_syntax_digest = CASE
              WHEN member_syntax_digest IS NULL THEN NULL ELSE ? END
      WHERE id = ?`,
    [
      memberDigest(db, componentId, "content"),
      memberDigest(db, componentId, "syntax"),
      componentId,
    ],
  );
}

function memberDigest(db: Db, componentId: string, basis: DigestBasis): string {
  const { files } = membersOf(db, componentId);
  const parts = files.sort().map((path) => {
    const signature = memberSignature(db, path);
    const term =
      basis === "syntax"
        ? (signature.syntaxSha ?? signature.contentSha ?? "")
        : (signature.contentSha ?? "");
    return `${path}:${term}`;
  });
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20);
}

/**
 * Which aggregate a box is compared on.
 *
 * Two digests are stored, not one. Changing what a single digest hashes would
 * have made every component drawn before syntax signatures existed drift the
 * moment its files gained one — and drift with nothing to name, because the
 * per-file comparison would correctly find no member changed. Nothing would
 * clear it except redrawing the whole map by hand, which is the model cost this
 * work exists to avoid.
 *
 * So `member_digest` keeps its original content meaning, and
 * `member_syntax_digest` carries the comment-invariant one. A box drawn before
 * the upgrade has no syntax digest and is compared the way it was drawn; the
 * next time it is described it gains one and stops churning on comments.
 */
type DigestBasis = "content" | "syntax";

/**
 * What a member file contributes to its box's identity.
 *
 * The syntax signature, not the content hash: a box describes what its code
 * *does*, and re-interpreting one because somebody rewrote a comment costs a
 * model call to reach the same conclusion. Files no parser covers, and indexes
 * predating syntax signatures, fall back to content — an unverifiable
 * comparison must not silently read as unchanged.
 */
function memberSignature(db: Db, path: string): RecordedSignatures {
  const row = db.get<{ content_sha: string; syntax_sha: string | null }>(
    "SELECT content_sha, syntax_sha FROM files WHERE path = ?",
    [path],
  );
  return { contentSha: row?.content_sha ?? null, syntaxSha: row?.syntax_sha ?? null };
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

/**
 * How many outside contracts one box may depend on before the list stops being
 * useful. Recorded so a truncated set reports as partial rather than clean.
 */
const MAX_COMPONENT_DEPENDENCIES = 500;

/**
 * What a box depends on that it does not contain.
 *
 * A component's description is written against the contracts its members call.
 * When one of those changes, the box may now describe something that is no
 * longer true — even though every file inside it is untouched, so no snapshot
 * comparison would ever notice. Recording the interface signature at drawing
 * time is what makes that answerable later.
 */
function recordComponentDependencies(db: Db, componentId: string): void {
  db.run(
    `DELETE FROM artifact_dependencies
      WHERE artifact_kind = 'component' AND artifact_id = ?
        AND signature_kind IN ('symbol-interface', 'coverage')`,
    [componentId],
  );
  const { files } = membersOf(db, componentId);
  if (files.length === 0) return;

  const placeholders = files.map(() => "?").join(", ");
  db.run(
    `INSERT OR REPLACE INTO artifact_dependencies(
       artifact_kind, artifact_id, signature_kind, depends_on, signature)
     SELECT 'component', ?, 'symbol-interface', s.symbol_key, s.interface_sha
       FROM refs r
       JOIN symbols s ON s.id = r.dst_symbol_id
      WHERE r.src_path IN (${placeholders})
        AND r.dst_path NOT IN (${placeholders})
        AND s.symbol_key IS NOT NULL AND s.interface_sha IS NOT NULL
      GROUP BY s.symbol_key
      LIMIT ?`,
    [componentId, ...files, ...files, MAX_COMPONENT_DEPENDENCIES + 1],
  );

  // A silently truncated dependency set would let an omitted contract change
  // while the box still reported clean. Record the overflow as a dependency of
  // its own, so it is impossible to read the box as fully checked.
  const recorded = db.count(
    `SELECT COUNT(*) AS n FROM artifact_dependencies
      WHERE artifact_kind = 'component' AND artifact_id = ?
        AND signature_kind = 'symbol-interface'`,
    [componentId],
  );
  if (recorded > MAX_COMPONENT_DEPENDENCIES) {
    db.run(
      `INSERT OR REPLACE INTO artifact_dependencies(
         artifact_kind, artifact_id, signature_kind, depends_on, signature)
       VALUES('component', ?, 'coverage', 'external-contracts', ?)`,
      [componentId, `truncated at ${MAX_COMPONENT_DEPENDENCIES}`],
    );
  }
}

/** Contracts a box was drawn against that have since moved. */
function changedDependencies(
  db: Db,
  componentId: string,
): Array<{ symbol: string; path: string }> {
  const changed = db
    .all<{ depends_on: string; path: string | null }>(
      `SELECT d.depends_on,
              (SELECT s.path FROM symbols s WHERE s.symbol_key = d.depends_on LIMIT 1) AS path
         FROM artifact_dependencies d
        WHERE d.artifact_kind = 'component' AND d.artifact_id = ?
          AND d.signature_kind = 'symbol-interface'
          AND NOT EXISTS (
            SELECT 1 FROM symbols s
             WHERE s.symbol_key = d.depends_on AND s.interface_sha = d.signature)
        ORDER BY d.depends_on`,
      [componentId],
    )
    .map((row) => ({ symbol: symbolNameFromKey(row.depends_on), path: row.path ?? "" }));

  const truncated = db.get<{ signature: string }>(
    `SELECT signature FROM artifact_dependencies
      WHERE artifact_kind = 'component' AND artifact_id = ? AND signature_kind = 'coverage'`,
    [componentId],
  );
  if (truncated) {
    // Coverage is partial, so this box can never report itself checked.
    changed.push({
      symbol: `more dependencies than were recorded (${truncated.signature})`,
      path: "",
    });
  }
  return changed;
}

/** `path#kind:name#ordinal` — the name sits between the colon and the ordinal. */
function symbolNameFromKey(key: string): string {
  const colon = key.indexOf(":");
  const hash = key.lastIndexOf("#");
  return colon >= 0 && hash > colon ? key.slice(colon + 1, hash) : key;
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
    db.run("UPDATE components SET member_digest = ?, member_syntax_digest = ? WHERE id = ?", [
      memberDigest(db, id, "content"),
      memberDigest(db, id, "syntax"),
      id,
    ]);

    // Per-file snapshot, so drift can name the files rather than the box.
    db.run("DELETE FROM component_snapshot WHERE component_id = ?", [id]);
    for (const path of membersOf(db, id).files) {
      const row = db.get<{ content_sha: string; syntax_sha: string | null }>(
        "SELECT content_sha, syntax_sha FROM files WHERE path = ?",
        [path],
      );
      db.run(
        `INSERT OR REPLACE INTO component_snapshot(component_id, path, content_sha, syntax_sha)
         VALUES(?, ?, ?, ?)`,
        [id, path, row?.content_sha ?? "", row?.syntax_sha ?? null],
      );
    }

    recordComponentDependencies(db, id);
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

  // A resumed first drawing may inherit boxes from an earlier scan. Requiring
  // their evidence snapshots to be refreshed prevents a newly completed map
  // from appearing stale the moment it is shown.
  const current = systemMap(db);
  const staleComponents = current.components.filter((component) => component.drifted);
  const staleFlows = current.flows.filter((flow) =>
    flow.steps.some((step) => step.drifted || !step.resolves),
  );
  if (staleComponents.length > 0 || staleFlows.length > 0) {
    const names = [
      ...staleComponents.map((component) => component.name),
      ...staleFlows.map((flow) => flow.name),
    ];
    throw new Error(
      `Map still has ${names.length} stale component/flow item(s): ${names.slice(0, 10).join(", ")}. ` +
        "Re-describe them against the current index before finalizing.",
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
    // Both signatures: syntax decides whether the step drifted, content keeps
    // the exact revision this narrative was written against.
    const recorded = step.path
      ? signaturesToRecord(db, step.path)
      : { contentSha: null, syntaxSha: null };
    db.run(
      `INSERT INTO flow_steps(flow_id, ordinal, label, path, symbol, note, content_sha, syntax_sha)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        index,
        step.label,
        step.path ?? null,
        step.symbol ?? null,
        step.note ?? null,
        recorded.contentSha,
        recorded.syntaxSha,
      ],
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
    /** Indexed file revision this authored step was written against. */
    contentSha: string | null;
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
  /**
   * Boxes whose own files are untouched, but which were drawn against a
   * contract elsewhere that has since changed. No snapshot comparison can see
   * this: every file inside the box still hashes the same.
   */
  dependencyDrift: Array<{
    id: string;
    name: string;
    changed: Array<{ symbol: string; path: string }>;
  }>;
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
      // Compared on the same signature the digest uses, so a file cannot be
      // named as changed by a box that does not consider itself drifted.
      const drawnAt = new Map(
        db
          .all<{ path: string; content_sha: string; syntax_sha: string | null }>(
            "SELECT path, content_sha, syntax_sha FROM component_snapshot WHERE component_id = ?",
            [component.id],
          )
          .map((row) => [
            row.path,
            { contentSha: row.content_sha, syntaxSha: row.syntax_sha },
          ]),
      );
      const now = new Map(
        membersOf(db, component.id).files.map((path) => [path, memberSignature(db, path)]),
      );

      const changedFiles: string[] = [];
      for (const [path, current] of now) {
        const recorded = drawnAt.get(path);
        if (!recorded) changedFiles.push(`${path} (added)`);
        else if (!sameMeaning(recorded, current)) changedFiles.push(path);
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

  // A box whose own files are untouched can still have been drawn against a
  // contract that moved. Computed here at read time rather than written during
  // a scan: touching `components` re-indexes it for search on every rescan.
  const dependencyDrift = map.components
    .map((component) => ({
      id: component.id,
      name: component.name,
      changed: changedDependencies(db, component.id),
    }))
    .filter((component) => component.changed.length > 0);

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
    dependencyDrift,
    newlyUnassigned,
    clean:
      complete &&
      components.length === 0 &&
      flows.length === 0 &&
      dependencyDrift.length === 0 &&
      newlyUnassigned.length === 0,
  };
}

/**
 * A box drawn before syntax signatures is compared the way it was drawn.
 * Anything drawn since is compared on meaning, so comments stop costing a
 * redraw.
 */
function hasDrifted(
  db: Db,
  component: { id: string; member_digest: string | null; member_syntax_digest: string | null },
): boolean {
  if (component.member_syntax_digest) {
    return component.member_syntax_digest !== memberDigest(db, component.id, "syntax");
  }
  return (
    Boolean(component.member_digest) &&
    component.member_digest !== memberDigest(db, component.id, "content")
  );
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
    member_syntax_digest: string | null;
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
      drifted: hasDrifted(db, component),
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
          syntax_sha: string | null;
        }>(
          "SELECT label, path, symbol, note, content_sha, syntax_sha FROM flow_steps WHERE flow_id = ? ORDER BY ordinal",
          [flow.id],
        )
        .map((step) => ({
          label: step.label,
          path: step.path,
          symbol: step.symbol,
          note: step.note,
          contentSha: step.content_sha,
          component: step.path ? (componentOfFile.get(step.path)?.name ?? null) : null,
          // Why, not just whether. A step that drifted because somebody
          // renamed an exported function needs re-reading; one whose file was
          // deleted needs rewriting.
          freshness: step.path
            ? pathFreshness(db, step.path, {
                contentSha: step.content_sha,
                syntaxSha: step.syntax_sha,
              })
            : {
                state: "not-applicable" as const,
                reason: "This step names no file.",
                basis: "none" as const,
              },
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
                pathFreshness(db, step.path, {
                  contentSha: step.content_sha,
                  syntaxSha: step.syntax_sha,
                }).state !== "current"),
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
      .all<{ path: string; content_sha: string; syntax_sha: string | null }>(
        "SELECT path, content_sha, syntax_sha FROM component_snapshot WHERE component_id = ?",
        [id],
      )
      .map((row) => [row.path, { contentSha: row.content_sha, syntaxSha: row.syntax_sha }]),
  );

  const detail = files.map((path) => {
    const file = db.get<{ loc: number }>("SELECT loc FROM files WHERE path = ?", [path]);
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
      changed: (() => {
        const recorded = drawn.get(path);
        return recorded !== undefined && !sameMeaning(recorded, memberSignature(db, path));
      })(),
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

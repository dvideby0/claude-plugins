import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { scan } from "../scan/scan.js";
import { describeComponent, describeFlow, finalizeMap, mapDrift } from "../graph/map.js";
import { markExplored, relate, relationsFor } from "../graph/relations.js";
import { recall, remember } from "../memory/store.js";
import { orphanedOverlays } from "../scan/moves.js";
import { exec } from "../lib/exec.js";
import { cleanup, makeProject, writeFiles } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/lib/hash.ts": "export function hash(value: string): string {\n  return value;\n}\n",
  "src/api/caller.ts":
    'import { hash } from "../lib/hash.js";\n\nexport function handle(input: string): string {\n  return hash(input);\n}\n',
};

/** Everything a person can author about one file, in one place. */
async function authorKnowledgeAbout(root: string, path: string) {
  const db = await getDb(root);
  describeComponent(db, { name: "Library", members: ["src/lib/"] });
  describeFlow(db, { name: "Hashing", steps: [{ label: "hash the value", path }] });
  relate(db, {
    kind: "calls",
    srcPath: path,
    label: "hashes input",
    evidence: "return value;",
  });
  remember(db, {
    kind: "decision",
    title: "Hashing is identity for now",
    anchors: [{ path }],
  });
  markExplored(db, path, 1);
  return db;
}

describe("invalidation follows meaning, not bytes", () => {
  let root: string;
  afterEach(async () => {
    if (root) await cleanup(root);
  });

  it("leaves everything anchored to a file standing when only its comments change", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    let db = await authorKnowledgeAbout(root, "src/lib/hash.ts");
    finalizeMap(db, { acknowledgeUnassigned: ["src/api/caller.ts"] });
    expect(mapDrift(db).clean).toBe(true);

    await writeFile(
      join(root, "src/lib/hash.ts"),
      "// A note somebody added while reading this.\nexport function hash(value: string): string {\n  /* still the identity */\n  return value;\n}\n",
    );
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    // The file really did change, so it is re-read: its symbol ranges moved.
    // What did not change is what it means, and that is what everything
    // anchored to it was written about.
    expect(result.filesChanged).toBe(1);
    expect(result.filesSyntaxChanged).toBe(0);
    expect(
      db.get<{ start_line: number }>(
        "SELECT start_line FROM symbols WHERE path = 'src/lib/hash.ts' AND name = 'hash'",
      )?.start_line,
    ).toBe(2);

    const drift = mapDrift(db);
    expect(drift.clean).toBe(true);
    expect(drift.components).toEqual([]);
    expect(drift.flows).toEqual([]);

    expect(relationsFor(db, "src/lib/hash.ts")[0]).toMatchObject({
      stale: false,
      freshness: { state: "current", basis: "syntax" },
    });
    const memory = recall(db, "hashing")[0];
    expect(memory?.anchors[0]).toMatchObject({ stale: false });
    // The reason says what happened, not merely that nothing did.
    expect(memory?.anchors[0]?.freshness.reason).toContain("only in comments or formatting");
  });

  it("drifts everything anchored to a file when its body changes", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    let db = await authorKnowledgeAbout(root, "src/lib/hash.ts");
    finalizeMap(db, { acknowledgeUnassigned: ["src/api/caller.ts"] });

    await writeFile(
      join(root, "src/lib/hash.ts"),
      "export function hash(value: string): string {\n  return value.trim();\n}\n",
    );
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(result.filesSyntaxChanged).toBe(1);
    const drift = mapDrift(db);
    expect(drift.clean).toBe(false);
    expect(drift.components.map((component) => component.name)).toEqual(["Library"]);
    expect(relationsFor(db, "src/lib/hash.ts")[0]?.stale).toBe(true);
    expect(recall(db, "hashing")[0]?.anchors[0]?.stale).toBe(true);
  });

  it("drifts a summary when a contract it was drawn against changes elsewhere", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    // The box holds only the caller. Nothing inside it will change.
    describeComponent(db, { name: "API", members: ["src/api/"] });
    finalizeMap(db, { acknowledgeUnassigned: ["src/lib/hash.ts", "package.json"] });
    expect(mapDrift(db).clean).toBe(true);

    await writeFile(
      join(root, "src/lib/hash.ts"),
      "export function hash(value: string, salt: string): string {\n  return value + salt;\n}\n",
    );
    await scan(root, { kind: "incremental" });
    db = await getDb(root);

    // No snapshot comparison could see this: src/api/caller.ts is untouched.
    const drift = mapDrift(db);
    expect(drift.components).toEqual([]);
    expect(drift.dependencyDrift).toHaveLength(1);
    expect(drift.dependencyDrift[0]).toMatchObject({ name: "API" });
    expect(drift.dependencyDrift[0]?.changed[0]).toMatchObject({
      symbol: "hash",
      path: "src/lib/hash.ts",
    });
    expect(drift.clean).toBe(false);
  });

  it("does not drift a summary when only the implementation behind it changes", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    describeComponent(db, { name: "API", members: ["src/api/"] });
    finalizeMap(db, { acknowledgeUnassigned: ["src/lib/hash.ts", "package.json"] });

    // Same contract, different body. A caller cannot tell, so neither should
    // anything written about the caller.
    await writeFile(
      join(root, "src/lib/hash.ts"),
      "export function hash(value: string): string {\n  const trimmed = value.trim();\n  return trimmed;\n}\n",
    );
    await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(mapDrift(db).dependencyDrift).toEqual([]);
  });

  it("does not cascade from a private declaration", async () => {
    root = await makeProject({
      ...PROJECT,
      "src/lib/hash.ts":
        "function helper(value: string): string {\n  return value;\n}\n\nexport function hash(value: string): string {\n  return helper(value);\n}\n",
    });
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    describeComponent(db, { name: "API", members: ["src/api/"] });
    finalizeMap(db, { acknowledgeUnassigned: ["src/lib/hash.ts", "package.json"] });

    await writeFile(
      join(root, "src/lib/hash.ts"),
      "function helper(value: string, mode: string): string {\n  return value + mode;\n}\n\nexport function hash(value: string): string {\n  return helper(value, \"x\");\n}\n",
    );
    await scan(root, { kind: "incremental" });
    db = await getDb(root);

    // A private symbol cannot be part of any other file's contract.
    expect(mapDrift(db).dependencyDrift).toEqual([]);
  });

  it("reports an index predating syntax signatures as unverified rather than fresh", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await authorKnowledgeAbout(root, "src/lib/hash.ts");

    // What an upgraded-but-not-yet-rescanned store looks like.
    db.run("UPDATE files SET syntax_sha = NULL");
    db.run("UPDATE relations SET syntax_sha = NULL");

    const relation = relationsFor(db, "src/lib/hash.ts")[0];
    expect(relation?.freshness.basis).toBe("content");
    expect(relation?.freshness.state).toBe("current");
  });
});

describe("files that move keep the knowledge written about them", () => {
  let root: string;
  afterEach(async () => {
    if (root) await cleanup(root);
  });

  async function git(cwd: string, ...args: string[]) {
    const result = await exec("git", args, { cwd, timeout: 15_000 });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  async function initRepository(cwd: string) {
    await git(cwd, "init", "--quiet");
    await git(cwd, "config", "user.email", "fixture@example.com");
    await git(cwd, "config", "user.name", "Fixture");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "--quiet", "-m", "fixture");
  }

  it("carries anchors across a rename Git confirms", async () => {
    root = await makeProject(PROJECT);
    await initRepository(root);
    await scan(root, { kind: "full" });
    let db = await authorKnowledgeAbout(root, "src/lib/hash.ts");

    await git(root, "mv", "src/lib/hash.ts", "src/lib/digest.ts");
    await writeFiles(root, {
      "src/api/caller.ts":
        'import { hash } from "../lib/digest.js";\n\nexport function handle(input: string): string {\n  return hash(input);\n}\n',
    });
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(result.filesMoved).toBe(1);
    expect(
      db.get<{ evidence: string }>("SELECT evidence FROM file_moves WHERE from_path = ?", [
        "src/lib/hash.ts",
      ])?.evidence,
    ).toBe("git-rename");

    // The note is about the code, and the code is still here.
    expect(recall(db, "hashing")[0]?.anchors[0]?.path).toBe("src/lib/digest.ts");
    expect(relationsFor(db, "src/lib/digest.ts")).toHaveLength(1);
    expect(
      db.count("SELECT COUNT(*) AS n FROM flow_steps WHERE path = 'src/lib/digest.ts'"),
    ).toBe(1);
    expect(
      db.count("SELECT COUNT(*) AS n FROM explorations WHERE path = 'src/lib/digest.ts'"),
    ).toBe(1);
    expect(orphanedOverlays(db)).toEqual([]);
  }, 30_000);

  it("refuses to guess when two identical files move at once", async () => {
    root = await makeProject({
      "package.json": "{}",
      "src/a.ts": "export const value = 1;\n",
      "src/b.ts": "export const value = 1;\n",
    });
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    remember(db, { kind: "decision", title: "About a", anchors: [{ path: "src/a.ts" }] });

    await writeFiles(root, {
      "src/moved-one.ts": "export const value = 1;\n",
      "src/moved-two.ts": "export const value = 1;\n",
    });
    await exec("rm", [join(root, "src/a.ts"), join(root, "src/b.ts")], { timeout: 10_000 });
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    // Two identical files carry no evidence about which became which, and a
    // wrong guess would silently re-anchor somebody's note onto other code.
    expect(result.filesMoved).toBe(0);
    expect(recall(db, "about a")[0]?.anchors[0]).toMatchObject({
      path: "src/a.ts",
      stale: true,
    });
  }, 30_000);

  it("lists knowledge left pointing at deleted code instead of dropping it", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    let db = await authorKnowledgeAbout(root, "src/lib/hash.ts");

    await exec("rm", [join(root, "src/lib/hash.ts")], { timeout: 10_000 });
    await scan(root, { kind: "incremental" });
    db = await getDb(root);

    // Deleting the overlay would throw away real knowledge over what might be
    // a branch switch. Leaving it invisible is what makes "no orphan facts"
    // untrue. Listing it is the third option.
    const orphans = orphanedOverlays(db);
    expect(orphans.map((row) => row.kind).sort()).toEqual(["flow-step", "memory", "relation"]);
    expect(orphans.every((row) => row.path === "src/lib/hash.ts")).toBe(true);
    expect(recall(db, "hashing")[0]?.anchors[0]?.freshness.reason).toContain(
      "no longer present in the index",
    );
  }, 30_000);
});

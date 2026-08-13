import { afterEach, describe, expect, it } from "vitest";
import { rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { scan } from "../scan/scan.js";
import { fileEvidenceBasis } from "../lib/freshness.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/lib/hash.ts": "export function hash(value: string): string {\n  return value;\n}\n",
  "src/lib/util.ts": "export function util(value: string): string {\n  return value;\n}\n",
  "src/api/caller.ts":
    'import { hash } from "../lib/hash.js";\n\nexport function handle(input: string): string {\n  return hash(input);\n}\n',
};

/**
 * Move a fixture's timestamps into the past.
 *
 * A file written and scanned in the same second is inside the racy window, so
 * the walk deliberately records no baseline for it and the next scan re-reads
 * it. That is correct, and it means a test that writes files and scans
 * immediately never exercises skipping at all — it would pass whether or not
 * any of this worked. Ageing the fixture is what puts the fast path under test
 * without making every test sleep for a second.
 */
async function settle(root: string, paths: string[]): Promise<void> {
  const past = new Date(Date.now() - 10_000);
  for (const path of paths) await utimes(join(root, path), past, past);
}

const ALL = ["package.json", "src/lib/hash.ts", "src/lib/util.ts", "src/api/caller.ts"];

describe("the walk skips a file the filesystem says did not change", () => {
  let root: string;
  afterEach(async () => {
    if (root) await cleanup(root);
  });

  it("verifies unchanged files without reading them, and says so", async () => {
    root = await makeProject(PROJECT);
    await settle(root, ALL);
    await scan(root, { kind: "full" });

    const warm = await scan(root, { kind: "incremental" });
    const db = await getDb(root);

    expect(warm.filesChanged).toBe(0);
    expect(warm.filesParsed).toBe(0);
    // Not every file is necessarily verified — a rotating slice is read anyway
    // to check the key. What must hold is that none was read because it looked
    // changed, and that every file is accounted for one way or the other.
    expect(warm.filesRead).toBe(0);
    expect(warm.filesVerified + warm.filesSampled).toBe(ALL.length);
    expect(
      db.count(
        "SELECT COUNT(*) AS n FROM files WHERE present = 1 AND freshness_basis IN ('verified','sampled')",
      ),
    ).toBe(ALL.length);

    // The facts a skipped file already had are still there — this is the whole
    // bet. Losing them would be a silent, total loss of the file's symbols.
    expect(db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = 'src/lib/hash.ts'")).toBe(1);
    expect(
      db.get<{ syntax_sha: string | null }>(
        "SELECT syntax_sha FROM files WHERE path = 'src/lib/hash.ts'",
      )?.syntax_sha,
    ).toBeTruthy();
    expect(db.count("SELECT COUNT(*) AS n FROM edges WHERE src_path = 'src/api/caller.ts'")).toBe(1);

    // And it can say how it knows. A verified file names the run that actually
    // read the bytes rather than the one that trusted the filesystem; a sampled
    // one was read by this run, so it names this run. Asserting the first
    // unconditionally would contradict the line above it and would break the
    // moment the rotation happened to pick this file.
    const evidence = fileEvidenceBasis(db, "src/lib/hash.ts");
    expect(["verified", "sampled"]).toContain(evidence.basis);
    expect(evidence.lastReadRun).toBe(evidence.basis === "sampled" ? 2 : 1);
    expect(evidence.lastSeenRun).toBe(2);
  });

  it("still notices a change that keeps the file the same size", async () => {
    // The direction that has to be right. A key built from size alone, or from
    // size and modification time with the time preserved, would miss this.
    root = await makeProject(PROJECT);
    await settle(root, ALL);
    await scan(root, { kind: "full" });

    const before = join(root, "src/lib/hash.ts");
    await writeFile(before, "export function hash(value: string): string {\n  return VALUE;\n}\n");
    const aged = new Date(Date.now() - 10_000);
    await utimes(before, aged, aged);

    const warm = await scan(root, { kind: "incremental" });
    const db = await getDb(root);

    expect(warm.filesChanged).toBe(1);
    expect(
      db.get<{ freshness_basis: string }>(
        "SELECT freshness_basis FROM files WHERE path = 'src/lib/hash.ts'",
      )?.freshness_basis,
    ).toBe("read");
    expect(["verified", "sampled"]).toContain(fileEvidenceBasis(db, "src/lib/util.ts").basis);
  });

  it("rebuilds an unchanged caller whose target was deleted", async () => {
    // The hazard the fast path introduces, and the reason it needs a way to
    // re-read a file by name. `src/api/caller.ts` did not change, so the walk
    // verifies it and returns no parse output — while the removal pass deletes
    // its references to the file that just went. Without the targeted re-read
    // the call is lost until a full scan, and nothing reports it.
    root = await makeProject(PROJECT);
    await settle(root, ALL);
    await scan(root, { kind: "full" });

    await rm(join(root, "src/lib/hash.ts"));
    await scan(root, { kind: "incremental" });
    let db = await getDb(root);

    // The reference survives as unresolved rather than disappearing.
    expect(
      db.get<{ dst_path: string | null }>(
        "SELECT dst_path FROM refs WHERE src_path = 'src/api/caller.ts' AND name = 'hash'",
      ),
    ).toMatchObject({ dst_path: null });

    // And it heals when the target comes back, which is what the unresolved
    // row was preserved for.
    await writeFile(
      join(root, "src/lib/hash.ts"),
      "export function hash(value: string): string {\n  return value;\n}\n",
    );
    await scan(root, { kind: "incremental" });
    db = await getDb(root);
    expect(
      db.get<{ dst_path: string | null }>(
        "SELECT dst_path FROM refs WHERE src_path = 'src/api/caller.ts' AND name = 'hash'",
      )?.dst_path,
    ).toBe("src/lib/hash.ts");
  });

  it("reads everything when the scan is a full one", async () => {
    root = await makeProject(PROJECT);
    await settle(root, ALL);
    await scan(root, { kind: "full" });
    await scan(root, { kind: "full", full: true });

    const db = await getDb(root);
    expect(
      db.count(
        "SELECT COUNT(*) AS n FROM files WHERE freshness_basis IN ('verified','sampled')",
      ),
    ).toBe(0);
    expect(db.count("SELECT COUNT(*) AS n FROM files WHERE freshness_basis = 'read'")).toBe(
      ALL.length,
    );
  });

  it("reads a file it has no usable baseline for", async () => {
    // A file written in the same tick as the walk that saw it records no key,
    // so the next scan reads it rather than trusting a key that could have been
    // captured mid-write. Cleared explicitly rather than relying on the fixture
    // landing inside that window: whether it does depends on which side of a
    // second boundary the scan starts, so asserting it directly would be a test
    // that fails a few times an hour for no reason.
    root = await makeProject(PROJECT);
    await settle(root, ALL);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    db.run("UPDATE files SET stat_key = NULL");

    const warm = await scan(root, { kind: "incremental" });
    expect(warm.filesChanged).toBe(0);
    expect(warm.filesRead).toBe(ALL.length);
    const after = await getDb(root);
    expect(after.count("SELECT COUNT(*) AS n FROM files WHERE freshness_basis = 'read'")).toBe(
      ALL.length,
    );
  });

  it("notices a file deleted between the walk's stat and its read", async () => {
    // The read-failure fallback keeps a sampled file whose extra read hits a
    // lock — it is still there, and dropping it would delete its symbols on
    // the strength of a rotation coin flip. A file that is *gone* is a
    // different error entirely, and taking the fallback for it would resurrect
    // it: reported verified, kept present, with every fact it used to have.
    root = await makeProject(PROJECT);
    await settle(root, ALL);
    await scan(root, { kind: "full" });

    await rm(join(root, "src/lib/util.ts"));
    const result = await scan(root, { kind: "incremental" });
    const db = await getDb(root);

    expect(result.filesRemoved).toBe(1);
    expect(
      db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1 AND path = 'src/lib/util.ts'"),
    ).toBe(0);
    expect(db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = 'src/lib/util.ts'")).toBe(0);
  });

  it("lets a full rescan clear a workspace that was distrusted", async () => {
    // The diagnostic tells the user this can be cleared, so something has to
    // clear it. A full scan is a deliberate act and not a pardon: sampling runs
    // again on the next incremental scan and distrusts the workspace again if
    // the filesystem is still lying.
    root = await makeProject(PROJECT);
    await settle(root, ALL);
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    db.run(
      "INSERT OR REPLACE INTO meta(key, value) VALUES('walk_freshness_distrusted', 'caught once')",
    );

    // While distrusted, no baseline is offered and everything is read.
    const slow = await scan(root, { kind: "incremental" });
    expect(slow.filesRead).toBe(ALL.length);
    expect(slow.freshnessDistrusted).toBe("caught once");

    const cleared = await scan(root, { kind: "full", full: true });
    expect(cleared.freshnessDistrusted).toBeNull();
    db = await getDb(root);
    expect(
      db.count("SELECT COUNT(*) AS n FROM meta WHERE key = 'walk_freshness_distrusted'"),
    ).toBe(0);

    // And the fast path is available again.
    const warm = await scan(root, { kind: "incremental" });
    expect(warm.filesRead).toBe(0);
  });

  it("rebuilds a caller in a repository whose gitignore rule had to be relaxed", async () => {
    // The rebuild asks the input policy whether it may read each path. A
    // repository whose catch-all `.gitignore` forced the walk to relax is
    // indexed under the relaxed rule, so the strict policy would reject every
    // path — rebuilding nothing and losing the reference silently, which is the
    // exact failure the targeted rebuild exists to prevent.
    root = await makeProject({ ...PROJECT, ".gitignore": "*\n" });
    await settle(root, [...ALL, ".gitignore"]);
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    expect(db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1")).toBeGreaterThan(0);

    await rm(join(root, "src/lib/hash.ts"));
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(result.inputDiagnostic).not.toContain("could not be re-read");
    expect(
      db.get<{ dst_path: string | null }>(
        "SELECT dst_path FROM refs WHERE src_path = 'src/api/caller.ts' AND name = 'hash'",
      ),
    ).toMatchObject({ dst_path: null });
  });
});

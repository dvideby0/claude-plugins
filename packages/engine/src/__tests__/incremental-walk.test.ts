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
    expect(
      db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1 AND freshness_basis = 'verified'"),
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

    // And it can say how it knows, naming the run that actually read the bytes
    // rather than the one that trusted the filesystem.
    const evidence = fileEvidenceBasis(db, "src/lib/hash.ts");
    expect(evidence.basis).toBe("verified");
    expect(evidence.lastReadRun).toBe(1);
    expect(evidence.lastSeenRun).toBe(2);
    expect(evidence.reason).toContain("did not read it again");
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
    expect(fileEvidenceBasis(db, "src/lib/util.ts").basis).toBe("verified");
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
    expect(db.count("SELECT COUNT(*) AS n FROM files WHERE freshness_basis = 'verified'")).toBe(0);
    expect(db.count("SELECT COUNT(*) AS n FROM files WHERE freshness_basis = 'read'")).toBe(
      ALL.length,
    );
  });

  it("reads a file it has no usable baseline for", async () => {
    // A file written in the same tick as the walk that saw it records no key,
    // so the next scan reads it rather than trusting a key that could have
    // been captured mid-write.
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(
      db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1 AND stat_key IS NULL"),
    ).toBeGreaterThan(0);

    const warm = await scan(root, { kind: "incremental" });
    expect(warm.filesChanged).toBe(0);
    const after = await getDb(root);
    expect(after.count("SELECT COUNT(*) AS n FROM files WHERE freshness_basis = 'read'")).toBe(
      ALL.length,
    );
  });
});

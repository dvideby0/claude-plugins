import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { scan } from "../scan/scan.js";
import { recordFindings } from "../findings/record.js";
import { findingsView, inputBoundaryView, exclusionForPath } from "../daemon/views.js";
import { cleanup, makeProject, writeFiles } from "./helpers.js";

/**
 * A repository that packages itself. `preload.cjs` is the exact file that
 * entered this project's own map as an unexplained, drifting entry.
 */
const PACKAGING_PROJECT = {
  ".gitignore": "release/\ngenerated/\n",
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/app.ts": "export const app = 1;\n",
  "src/util.ts": "export const util = 2;\n",
  "release/builder-debug.yml": "app: fixture\n",
  "release/mac-arm64/App.app/Contents/Resources/app/preload.cjs": "module.exports = {};\n",
  "release/mac-arm64/App.app/Contents/Resources/app/package.json": "{}\n",
  "generated/client.ts": "export const generated = 3;\n",
  "dist/bundle.js": "console.log(1);\n",
  "node_modules/pkg/index.ts": "export const dep = 4;\n",
};

/** A real problem in a file that a later rule stops indexing. */
const GENERATED_FINDING = {
  ruleId: "test/generated",
  category: "correctness",
  severity: "high",
  confidence: "high",
  source: "linter",
  path: "generated/client.ts",
  title: "Generated client has a problem",
  description: "Nobody has looked at this.",
} as const;

describe("repository input boundary", () => {
  let root: string;
  afterEach(async () => {
    if (root) await cleanup(root);
  });

  it("keeps packaged and generated output out of the inventory and says why", async () => {
    root = await makeProject(PACKAGING_PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const indexed = db
      .all<{ path: string }>("SELECT path FROM files WHERE present = 1 ORDER BY path")
      .map((row) => row.path);
    expect(indexed).toEqual(["package.json", "src/app.ts", "src/util.ts"]);

    // The defect this closes: a build of the application cannot become a fact
    // about the application.
    const packaged = exclusionForPath(
      db,
      "release/mac-arm64/App.app/Contents/Resources/app/preload.cjs",
    );
    expect(packaged?.reason).toBe("generated_output");
    expect(packaged?.detail).toContain("release/");

    const dependency = exclusionForPath(db, "node_modules/pkg/index.ts");
    expect(dependency?.reason).toBe("ignored_directory");
    expect(dependency?.directory).toBe(true);

    const reasons = Object.fromEntries(
      db
        .all<{ reason: string; paths: number }>("SELECT reason, paths FROM exclusion_summary")
        .map((row) => [row.reason, row.paths]),
    );
    expect(reasons.generated_output).toBeGreaterThan(0);
    expect(reasons.ignored_directory).toBeGreaterThan(0);
  });

  it("records a pruned directory once instead of enumerating what is inside it", async () => {
    root = await makeProject(PACKAGING_PROJECT);
    await writeFiles(
      root,
      Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `node_modules/pkg/deep/m${index}.ts`,
          "export {};\n",
        ]),
      ),
    );
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const recorded = db
      .all<{ path: string }>(
        "SELECT path FROM excluded_paths WHERE reason = 'ignored_directory' ORDER BY path",
      )
      .map((row) => row.path);
    expect(recorded).toEqual(["dist", "node_modules"]);

    // The pruned directory still answers for everything beneath it.
    expect(exclusionForPath(db, "node_modules/pkg/deep/m7.ts")?.path).toBe("node_modules");
  });

  it("retires facts for files a newly added rule excludes", async () => {
    // The shrink direction is the risky one: adding a rule removes real facts,
    // so it has to go through the same retirement path as a deleted file.
    root = await makeProject({
      "package.json": "{}",
      "src/app.ts": "export const app = 1;\n",
      "generated/client.ts": "export const generated = 3;\n",
    });
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    expect(
      db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1 AND path = 'generated/client.ts'"),
    ).toBe(1);
    expect(db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = 'generated/client.ts'")).toBe(1);

    await writeFile(join(root, ".gitignore"), "generated/\n");
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(result.filesRemoved).toBe(1);
    expect(
      db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1 AND path = 'generated/client.ts'"),
    ).toBe(0);
    expect(db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = 'generated/client.ts'")).toBe(0);
    expect(exclusionForPath(db, "generated/client.ts")?.reason).toBe("generated_output");
  });

  it("retires a finding on a newly excluded path instead of claiming it was fixed", async () => {
    // A scan runs no analyzers. Reporting "fixed" here told somebody their
    // problem had been dealt with, when all that happened is we stopped
    // looking at the file — which is still sitting there containing it.
    root = await makeProject({
      "package.json": "{}",
      "src/app.ts": "export const app = 1;\n",
      "generated/client.ts": "export const generated = 3;\n",
    });
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    recordFindings(db, 1, [GENERATED_FINDING]);

    await writeFile(join(root, ".gitignore"), "generated/\n");
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(result.findingsRetired).toBe(1);
    expect(
      db.get<{ status: string; fixed_in_run: number | null }>(
        "SELECT status, fixed_in_run FROM findings WHERE path = 'generated/client.ts'",
      ),
    ).toMatchObject({ status: "retired", fixed_in_run: null });

    // Not counted as fixed by anything a person or an agent reads.
    expect(db.count("SELECT COUNT(*) AS n FROM findings WHERE status = 'fixed'")).toBe(0);
    const view = findingsView(db, 200, "retired");
    expect(view.byStatus.retired).toBe(1);
    expect(view.rows[0]?.excluded?.reason).toBe("generated_output");
    expect(findingsView(db, 200, "open").total).toBe(0);
  });

  it("still closes a finding as fixed when its file was actually deleted", async () => {
    // The discrimination test. Without it, the change above is unverified:
    // retiring everything would pass every assertion in it.
    root = await makeProject({
      "package.json": "{}",
      "src/app.ts": "export const app = 1;\n",
      "generated/client.ts": "export const generated = 3;\n",
    });
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    recordFindings(db, 1, [GENERATED_FINDING]);

    await rm(join(root, "generated/client.ts"));
    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(result.findingsRetired).toBe(0);
    expect(
      db.get<{ status: string }>("SELECT status FROM findings WHERE path = 'generated/client.ts'")
        ?.status,
    ).toBe("fixed");
  });

  it("reopens a retired finding as open rather than regressed", async () => {
    // Regressed means it was fixed and came back. Nothing fixed this one.
    root = await makeProject({
      "package.json": "{}",
      "src/app.ts": "export const app = 1;\n",
      "generated/client.ts": "export const generated = 3;\n",
    });
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    recordFindings(db, 1, [GENERATED_FINDING]);

    await writeFile(join(root, ".gitignore"), "generated/\n");
    await scan(root, { kind: "incremental" });
    db = await getDb(root);
    expect(
      db.get<{ status: string }>("SELECT status FROM findings WHERE path = 'generated/client.ts'")
        ?.status,
    ).toBe("retired");

    // The rule is lifted, the file comes back, and the analyzer finds it again.
    await rm(join(root, ".gitignore"));
    await scan(root, { kind: "incremental" });
    db = await getDb(root);

    // Between the file returning and an analyzer re-checking it, the finding
    // is neither excluded nor confirmed. Saying "no longer indexed" here would
    // be false, and so would naming a rule that no longer applies.
    const waiting = findingsView(db, 200, "retired").rows[0];
    expect(waiting).toMatchObject({ reindexed: true, excluded: null });

    recordFindings(db, 3, [GENERATED_FINDING]);
    expect(
      db.get<{ status: string }>("SELECT status FROM findings WHERE path = 'generated/client.ts'")
        ?.status,
    ).toBe("open");
  });

  it("does not call a path still present when a directory took its place", async () => {
    // `existsSync` answered "is there anything here", which a directory of the
    // same name satisfies. The file is gone, so its finding is fixed.
    root = await makeProject({
      "package.json": "{}",
      "src/app.ts": "export const app = 1;\n",
      "generated/client.ts": "export const generated = 3;\n",
    });
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    recordFindings(db, 1, [GENERATED_FINDING]);

    await rm(join(root, "generated/client.ts"));
    await mkdir(join(root, "generated/client.ts"), { recursive: true });
    await writeFile(join(root, "generated/client.ts/index.ts"), "export const moved = 3;\n");

    const result = await scan(root, { kind: "incremental" });
    db = await getDb(root);

    expect(result.findingsRetired).toBe(0);
    expect(
      db.get<{ status: string }>("SELECT status FROM findings WHERE path = 'generated/client.ts'")
        ?.status,
    ).toBe("fixed");
  });

  it("reports the boundary through the overview the desktop already loads", async () => {
    root = await makeProject(PACKAGING_PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const boundary = inputBoundaryView(db);
    expect(boundary.excludedTotal).toBeGreaterThan(0);
    const generated = boundary.byReason.find((row) => row.reason === "generated_output");
    expect(generated?.paths).toBeGreaterThan(0);
    expect(boundary.samples.some((row) => row.path === "release")).toBe(true);

    // High-volume, low-value reasons are counted but never listed per path.
    expect(boundary.samples.some((row) => row.reason === "unsupported_extension")).toBe(false);
  });

  it("never reports an empty repository because one rule matched everything", async () => {
    root = await makeProject({
      ".gitignore": "*\n",
      "package.json": "{}",
      "src/app.ts": "export const app = 1;\n",
    });
    const result = await scan(root, { kind: "full" });

    expect(result.filesTotal).toBeGreaterThan(0);
    expect(result.inputDiagnostic).toContain(".gitignore");
  });
});

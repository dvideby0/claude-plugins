import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { scan } from "../scan/scan.js";
import { inputBoundaryView, exclusionForPath } from "../daemon/views.js";
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

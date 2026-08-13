import { afterEach, describe, expect, it } from "vitest";
import { rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject, writeFiles } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
  }),
  "src/lib/hash.ts": "export function hash(value: string): string {\n  return value;\n}\n",
  "src/api/caller.ts":
    'import { hash } from "../lib/hash.js";\n\nexport function handle(input: string): string {\n  return hash(input);\n}\n',
  "src/api/aliased.ts":
    'import { hash } from "@lib/hash.js";\n\nexport const aliased = hash;\n',
  "src/api/external.ts": 'import { readFile } from "node:fs/promises";\n\nexport const read = readFile;\n',
  "pkg/__init__.py": "",
  "pkg/store.py": "def put(value):\n    return value\n",
  "pkg/writer.py": "from pkg.store import put\n\n\ndef write(value):\n    return put(value)\n",
};

/** Everything the resolver produced, in a form two runs can be compared by. */
async function resolutions(root: string): Promise<string[]> {
  const db = await getDb(root);
  const edges = db.all<{ src_path: string; specifier: string; dst: string; ext: string }>(
    `SELECT src_path, specifier, COALESCE(dst_path, '-') AS dst, COALESCE(external, '-') AS ext
       FROM edges ORDER BY src_path, specifier`,
  );
  const refs = db.all<{ src_path: string; specifier: string; dst: string }>(
    `SELECT DISTINCT src_path, specifier, COALESCE(dst_path, '-') AS dst
       FROM refs ORDER BY src_path, specifier`,
  );
  return [
    ...edges.map((row) => `edge ${row.src_path} ${row.specifier} -> ${row.dst} / ${row.ext}`),
    ...refs.map((row) => `ref ${row.src_path} ${row.specifier} -> ${row.dst}`),
  ];
}

/** Take the fixture out of the racy window so the walk can skip it. */
async function settle(root: string, paths: string[]): Promise<void> {
  const past = new Date(Date.now() - 10_000);
  for (const path of paths) await utimes(join(root, path), past, past);
}

describe("edges are re-resolved only where the relation set moved", () => {
  let root: string;
  afterEach(async () => {
    if (root) await cleanup(root);
  });

  it("agrees with a full re-resolution after a sequence of real changes", async () => {
    // The headline proof, and the only one that would catch a gate that is
    // subtly too clever. Every claim about which rows can be skipped is
    // checked by doing the work the slow way and comparing.
    root = await makeProject(PROJECT);
    await settle(root, Object.keys(PROJECT));
    await scan(root, { kind: "full" });

    // A comment: bytes change, relation set does not.
    await writeFile(
      join(root, "src/lib/hash.ts"),
      "// a note\nexport function hash(value: string): string {\n  return value;\n}\n",
    );
    await scan(root, { kind: "incremental" });

    // A new import: the relation set moves.
    await writeFile(
      join(root, "src/api/caller.ts"),
      'import { hash } from "../lib/hash.js";\nimport { util } from "../lib/util.js";\n\nexport function handle(input: string): string {\n  return hash(util(input));\n}\n',
    );
    await scan(root, { kind: "incremental" });

    // A new file that satisfies a specifier which was unresolved a moment ago.
    // Nothing in `caller.ts` changed this time, so a gate that only looked at
    // the source file would leave the edge dangling.
    await writeFiles(root, {
      "src/lib/util.ts": "export function util(value: string): string {\n  return value;\n}\n",
    });
    await scan(root, { kind: "incremental" });

    // A deletion, which breaks an edge that was resolved.
    await rm(join(root, "src/lib/util.ts"));
    await scan(root, { kind: "incremental" });

    // And it comes back.
    await writeFiles(root, {
      "src/lib/util.ts": "export function util(value: string): string {\n  return value;\n}\n",
    });
    const gated = await scan(root, { kind: "incremental" });

    const incremental = await resolutions(root);
    await scan(root, { kind: "full", full: true });
    expect(incremental).toEqual(await resolutions(root));
    expect(gated.unresolvedImports).toBe(0);
  });

  it("resolves a specifier that a new file satisfies, without the source changing", async () => {
    root = await makeProject({
      ...PROJECT,
      "src/api/caller.ts":
        'import { later } from "../lib/later.js";\n\nexport const call = later;\n',
    });
    await settle(root, Object.keys(PROJECT));
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    expect(
      db.get<{ dst_path: string | null }>(
        "SELECT dst_path FROM edges WHERE src_path = 'src/api/caller.ts'",
      )?.dst_path,
    ).toBeNull();

    await writeFiles(root, { "src/lib/later.ts": "export const later = 1;\n" });
    await scan(root, { kind: "incremental" });
    db = await getDb(root);
    expect(
      db.get<{ dst_path: string | null }>(
        "SELECT dst_path FROM edges WHERE src_path = 'src/api/caller.ts'",
      )?.dst_path,
    ).toBe("src/lib/later.ts");
  });

  it("re-resolves aliased imports when tsconfig paths change and no file does", async () => {
    // The alias table is a resolver input, so it has to be in the identity.
    // Nothing else about the repository changes here.
    root = await makeProject(PROJECT);
    await settle(root, Object.keys(PROJECT));
    await scan(root, { kind: "full" });
    let db = await getDb(root);
    expect(
      db.get<{ dst_path: string | null }>(
        "SELECT dst_path FROM edges WHERE src_path = 'src/api/aliased.ts'",
      )?.dst_path,
    ).toBe("src/lib/hash.ts");

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/other/*"] } } }),
    );
    await writeFiles(root, { "src/other/hash.ts": "export const hash = 1;\n" });
    await scan(root, { kind: "incremental" });
    db = await getDb(root);
    expect(
      db.get<{ dst_path: string | null }>(
        "SELECT dst_path FROM edges WHERE src_path = 'src/api/aliased.ts'",
      )?.dst_path,
    ).toBe("src/other/hash.ts");
  });

  it("leaves every resolved edge exactly as it was when only a comment changes", async () => {
    root = await makeProject(PROJECT);
    await settle(root, Object.keys(PROJECT));
    await scan(root, { kind: "full" });
    const before = await resolutions(root);
    const db = await getDb(root);
    const relationSet = db.get<{ relation_set_sha: string }>(
      "SELECT relation_set_sha FROM files WHERE path = 'src/api/caller.ts'",
    )?.relation_set_sha;

    await writeFile(
      join(root, "src/api/caller.ts"),
      '// somebody read this\nimport { hash } from "../lib/hash.js";\n\nexport function handle(input: string): string {\n  return hash(input);\n}\n',
    );
    const result = await scan(root, { kind: "incremental" });

    expect(result.filesChanged).toBe(1);
    expect(await resolutions(root)).toEqual(before);
    // The reader exists and fired: the file was re-parsed, and its relation set
    // is what said its resolutions did not need redoing.
    const after = await getDb(root);
    expect(
      after.get<{ relation_set_sha: string }>(
        "SELECT relation_set_sha FROM files WHERE path = 'src/api/caller.ts'",
      )?.relation_set_sha,
    ).toBe(relationSet);
  });
});

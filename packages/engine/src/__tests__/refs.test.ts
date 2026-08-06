import { describe, expect, it, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { impactOf, referencesTo } from "../graph/refs.js";
import { buildBrief } from "../graph/brief.js";
import { parseFile } from "../scan/parse.js";
import { EXTRACTION_VERSION, scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { resolveTypes } from "../graph/typed.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/db.ts": `
export function connect(url: string) { return { url }; }
export function query(sql: string) { return sql; }
export function unused() { return 1; }
`,
  "src/users.ts": `
import { query } from "./db";
export function getUser(id: string) { return query("a" + id); }
export function listUsers() { return query("b"); }
`,
  "src/orders.ts": `
import { query as run } from "./db";
import { getUser } from "./users";
export function getOrders(id: string) { return run("c") + getUser(id); }
`,
  "src/namespace.ts": `
import * as db from "./db";
export function byNamespace() { return db.query("namespace"); }
`,
  "src/shadow.ts": `
import { query } from "./db";
export function useCallback(query: (sql: string) => string) { return query("local"); }
`,
  "src/default.ts": `
export default function initialize() { return "ready"; }
`,
  "src/default-user.ts": `
import start from "./default";
export function boot() { return start(); }
`,
  "src/db.test.ts": `
import { connect } from "./db";
connect("x");
`,
  "src/util.py": `
from .helpers import shout

def loud(text):
    return shout(text)
`,
  "src/helpers.py": `
def shout(text):
    return text.upper()
`,
  "src/shadow.py": `
from .helpers import shout

def apply_local(shout):
    return shout("local callback")
`,
  "src/module_user.py": `
import helpers

def module_loud(text):
    return helpers.shout(text)
`,
  "pkg/db.py": `
def fetch_rows(sql):
    return sql
`,
  "src/dotted_user.py": `
import pkg.db

def dotted_query():
    return pkg.db.fetch_rows("select 1")
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

// Reference extraction lives in the native core; without it these are empty
// by design, so the suite still passes on a platform with no build.
const native = loadNative();
const withNative = native ? describe : describe.skip;

withNative("symbol references", () => {
  it("backfills references when a current fallback index gains native support", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    db.run("DELETE FROM refs");
    db.run("UPDATE files SET ref_coverage = 'none'");
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('extraction_version', ?)", [
      String(EXTRACTION_VERSION),
    ]);
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('extraction_engine', 'typescript')");

    const result = await scan(root, { kind: "incremental" });
    expect(result.upgraded).toBe(true);
    expect(result.filesParsed).toBeGreaterThan(0);
    expect(referencesTo(db, "query").total).toBe(4);
  });

  it("resolves uses of imported names, including aliases", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const query = referencesTo(db, "query");
    expect(query.definedIn).toBe("src/db.ts");
    expect(query.exported).toBe(true);
    // Two named uses in users.ts, one alias, and one namespace member.
    expect(query.total).toBe(4);
    expect(query.files.sort()).toEqual(["src/namespace.ts", "src/orders.ts", "src/users.ts"]);

    // The alias is recorded under the name the defining module exports.
    const aliased = query.callSites.filter((site) => site.path === "src/orders.ts");
    expect(aliased).toHaveLength(1);
  });

  it("does not count the import statement itself as a use", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const connect = referencesTo(db, "connect");
    expect(connect.total).toBe(1);
    expect(connect.callSites[0]?.path).toBe("src/db.test.ts");
    // Line 3 is the call; line 2 is the import.
    expect(connect.callSites[0]?.line).toBe(3);
  });

  it("reports an export nothing uses", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(referencesTo(db, "unused").total).toBe(0);
  });

  it("resolves python from-imports", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const shout = referencesTo(db, "shout");
    expect(shout.definedIn).toBe("src/helpers.py");
    expect(shout.total).toBe(2);
    expect(shout.files.sort()).toEqual(["src/module_user.py", "src/util.py"]);
  });

  it("does not resolve a shadowing parameter as the imported symbol", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const shout = referencesTo(db, "shout");
    expect(shout.callSites.some((site) => site.path === "src/shadow.py")).toBe(false);

    const query = referencesTo(db, "query");
    expect(query.callSites.some((site) => site.path === "src/shadow.ts")).toBe(false);
  });

  it("maps default imports to the declaration's real identity", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(
      db.get<{ default_export: number }>(
        "SELECT default_export FROM symbols WHERE path = 'src/default.ts' AND name = 'initialize'",
      )?.default_export,
    ).toBe(1);
    expect(referencesTo(db, "initialize").files).toContain("src/default-user.ts");
    expect(
      db.get<{ name: string }>("SELECT name FROM refs WHERE src_path = 'src/default-user.ts'")
        ?.name,
    ).toBe("initialize");
  });

  it("resolves the symbol used through an unaliased dotted Python import", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const rows = referencesTo(db, "fetch_rows");
    expect(rows.definedIn).toBe("pkg/db.py");
    expect(rows.files).toContain("src/dotted_user.py");
    expect(rows.callSites.find((site) => site.path === "src/dotted_user.py")?.line).toBe(5);
  });

  it("separates blast radius from import count", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const impact = impactOf(db, "db.ts");
    expect(impact.resolved).toBe("src/db.ts");
    expect(impact.directImporters).toBe(5);

    const byName = Object.fromEntries(impact.symbols.map((s) => [s.name, s.references]));
    expect(byName.query).toBe(4);
    expect(byName.connect).toBe(1);
    expect(byName.unused).toBe(0);

    // The test file that exercises it is called out from the rest.
    expect(impact.coveringTests).toEqual(["src/db.test.ts"]);
  });

  it("drops references when the using file goes away", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    expect(referencesTo(db, "getUser").total).toBe(1);

    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(root, "src/orders.ts"));
    await scan(root, { kind: "incremental" });

    expect(referencesTo(db, "getUser").total).toBe(0);
  });
});

describe("reference coverage", () => {
  it("preserves default export identity in the TypeScript parser fallback", async () => {
    const parsed = await parseFile(
      "src/default.ts",
      "typescript",
      "export default function initialize() { return true; }",
    );
    expect(parsed.symbols.find((symbol) => symbol.name === "initialize")).toMatchObject({
      exported: true,
      defaultExport: true,
    });
  });

  it("reports unavailable reference analysis as unknown rather than empty", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    // Model the supported fallback path explicitly even on a machine that has
    // the native module, so this assertion runs in both CI variants.
    db.run("DELETE FROM refs");
    db.run("UPDATE files SET ref_coverage = 'none'");

    const impact = impactOf(db, "src/db.ts");
    expect(impact.referenceCoverage).toBe("none");
    const brief = buildBrief(db, "src/db.ts").text;
    expect(brief).toContain("precise references are unknown");
    expect(brief).toContain("Test coverage is unknown");
    expect(brief).not.toContain("Nothing references it");
    expect(brief).not.toContain("No test covers it");
  });

  it("derives incoming coverage from importers rather than the declaration file", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "coverage", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/api.ts": "export function run() { return 1; }\n",
      "src/app.ts": "import { run } from './api.js';\nexport const result = run();\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    resolveTypes(db, root);
    expect(referencesTo(db, "run").referenceCoverage).toBe("typed");

    await writeFile(
      join(root, "src/app.ts"),
      "import { run } from './api.js';\nexport const result = run() + 1;\n",
    );
    await scan(root, { kind: "incremental" });

    // The native rescan provides import-level facts for the changed source;
    // it must not inherit the untouched declaration's stronger typed label.
    expect(referencesTo(db, "run").referenceCoverage).toBe("import");
    expect(impactOf(db, "src/api.ts").referenceCoverage).toBe("import");

    // On the TypeScript fallback the same source has no reference extraction.
    db.run("UPDATE files SET ref_coverage = 'none' WHERE path = 'src/app.ts'");
    expect(referencesTo(db, "run").referenceCoverage).toBe("none");
    expect(impactOf(db, "src/api.ts").referenceCoverage).toBe("none");
  });

  it("treats typed zeroes for methods as real results", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "typed-zero", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/store.ts": "export class Store { unused(): void {} }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    resolveTypes(db, root);

    const brief = buildBrief(db, "src/store.ts").text;
    expect(brief).toContain("`unused` (method");
    expect(brief).toContain("unused elsewhere");
    expect(brief).not.toContain("uses not tracked");
  });
});

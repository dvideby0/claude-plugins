import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { impactOf, referencesTo } from "../graph/refs.js";
import { neighbourhood } from "../memory/context.js";
import { buildTaskContext } from "../plan/task-context.js";
import { EXTRACTION_VERSION, scan } from "../scan/scan.js";
import { resolveTypes } from "../graph/typed.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
    include: ["src/**/*"],
  }),
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
  "pkg/__init__.py": "",
  "pkg/helpers.py": `
def wave():
    return "hello"
`,
  "pkg/from_module.py": `
from pkg import helpers

def absolute_wave():
    return helpers.wave()
`,
  "pkg/from_relative.py": `
from . import helpers

def relative_wave():
    return helpers.wave()
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

describe("symbol references", () => {
  it("backfills references when a legacy TypeScript index gains native support", async () => {
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
    // Keep the stable export slot in the row; destination identity maps it to
    // the declaration currently occupying that slot.
    expect(
      db.get<{ name: string }>("SELECT name FROM refs WHERE src_path = 'src/default-user.ts'")
        ?.name,
    ).toBe("default");
  });

  it("remaps an unchanged default importer when the declaration is renamed", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).ran).toBe(true);

    await writeFile(
      join(root, "src/default.ts"),
      'export default function launch() { return "ready"; }\n',
    );
    await scan(root, { kind: "incremental" });

    expect(referencesTo(db, "initialize").definedIn).toBeNull();
    expect(referencesTo(db, "launch").files).toContain("src/default-user.ts");
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

  it("resolves namespace members imported through Python from-imports", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const wave = referencesTo(db, "wave");
    expect(wave.definedIn).toBe("pkg/helpers.py");
    expect(wave.files.sort()).toEqual(["pkg/from_module.py", "pkg/from_relative.py"]);
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

    await rm(join(root, "src/orders.ts"));
    await scan(root, { kind: "incremental" });

    expect(referencesTo(db, "getUser").total).toBe(0);
  });

  it("restores incoming references when a deleted target returns unchanged", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    expect(referencesTo(db, "query").total).toBe(4);

    await rm(join(root, "src/db.ts"));
    await scan(root, { kind: "incremental" });
    expect(referencesTo(db, "query").total).toBe(0);

    await writeFile(join(root, "src/db.ts"), PROJECT["src/db.ts"]);
    await scan(root, { kind: "incremental" });
    expect(referencesTo(db, "query").total).toBe(4);
  });
});

describe("reference coverage", () => {
  it("returns candidates instead of guessing between ambiguous impact suffixes", async () => {
    root = await makeProject({
      "services/a/db.ts": "export function alpha() { return 1; }\n",
      "services/b/db.ts": "export function beta() { return 2; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const ambiguous = impactOf(db, "db.ts");
    expect(ambiguous.resolved).toBeNull();
    expect(ambiguous.candidates).toEqual(["services/a/db.ts", "services/b/db.ts"]);
    expect(impactOf(db, "services/a/db.ts").resolved).toBe("services/a/db.ts");
  });

  it("finds covering tests outside the affected-file display page", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "coverage-page", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/api.ts": "export function run() { return 1; }\n",
      "src/a.ts": "import { run } from './api.js';\nexport const value = run();\n",
      "src/z.test.ts": "import { run } from './api.js';\nrun();\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    resolveTypes(db, root);

    const impact = impactOf(db, "src/api.ts", 1);
    expect(impact.affectedFiles).toEqual(["src/a.ts"]);
    expect(impact.coveringTests).toEqual(["src/z.test.ts"]);
  });

  it("reports unavailable reference analysis as unknown rather than empty", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    // Model unavailable provider facts explicitly. The product must preserve
    // unknown coverage rather than turning missing evidence into a false zero.
    db.run("DELETE FROM refs");
    db.run("UPDATE files SET ref_coverage = 'none'");

    const impact = impactOf(db, "src/db.ts");
    expect(impact.referenceCoverage).toBe("none");
    const brief = (
      await buildTaskContext(db, root, {
        targets: ["src/db.ts"],
        intent: "review",
      })
    ).text;
    expect(brief).toContain("reference analysis is unavailable");
    expect(brief).toContain("means unknown, not unused");
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

    // A native rescan provides import-level facts for the changed source. It
    // must not inherit the untouched declaration's stronger typed label.
    expect(referencesTo(db, "run").referenceCoverage).toBe("import");
    expect(impactOf(db, "src/api.ts").referenceCoverage).toBe("import");
    expect(neighbourhood(db, "src/api.ts").file?.referenceCoverage).toBe("import");

    // Explicitly model a provider that supplied no reference facts.
    db.run("UPDATE files SET ref_coverage = 'none' WHERE path = 'src/app.ts'");
    expect(referencesTo(db, "run").referenceCoverage).toBe("none");
    expect(impactOf(db, "src/api.ts").referenceCoverage).toBe("none");
    expect(neighbourhood(db, "src/api.ts").file?.referenceCoverage).toBe("none");
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

    const brief = await buildTaskContext(db, root, {
      task: "change Store unused method",
      targets: ["src/store.ts"],
      intent: "refactor",
    });
    expect(brief.evidence.some((item) => item.title.endsWith("#unused"))).toBe(true);
    expect(brief.uncertainties).not.toContain(
      expect.stringContaining("method calls and type positions can be incomplete"),
    );
  });
});

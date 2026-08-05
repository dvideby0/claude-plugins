import { describe, expect, it, afterEach } from "vitest";
import { getDb } from "../db/db.js";
import { impactOf, referencesTo } from "../graph/refs.js";
import { buildBrief } from "../graph/brief.js";
import { scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
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
    expect(impact.directImporters).toBe(4);

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
});

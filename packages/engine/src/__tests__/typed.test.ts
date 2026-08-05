import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { referencesTo } from "../graph/refs.js";
import { resolveTypes } from "../graph/typed.js";
import { scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
    },
    include: ["src/**/*"],
  }),
  "src/store.ts": `
export class Store {
  private items: string[] = [];
  add(item: string): void { this.items.push(item); }
  size(): number { return this.items.length; }
  clear(): void { this.items = []; }
}
export function makeStore(): Store { return new Store(); }
`,
  "src/app.ts": `
import { makeStore } from "./store.js";

export function run(): number {
  const store = makeStore();
  store.add("a");
  store.add("b");
  return store.size();
}
`,
  "src/reset.ts": `
import { makeStore } from "./store.js";
export function wipe() {
  const s = makeStore();
  s.clear();
  return s.size();
}
`,
};

/** The fast pass ships only in the native core; the fallback records no refs. */
const hasNative = Boolean(loadNative());

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("typed resolution", () => {
  it("resolves method calls that import resolution cannot see", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    // The fast pass only exists in the native core, so this baseline is
    // asserted where there is one. Typed resolution below replaces these rows
    // outright and is therefore checked on both paths.
    if (hasNative) {
      // Import-based resolution sees makeStore, because it is imported by name.
      expect(referencesTo(db, "makeStore").total).toBe(2);
      // It cannot see `store.add(...)`: nothing named `add` was ever imported.
      expect(referencesTo(db, "add").total).toBe(0);
    }

    const result = resolveTypes(db, root);
    expect(result.ran).toBe(true);
    expect(result.filesAnalysed).toBeGreaterThan(0);

    // The checker knows `store` is a Store, so the method calls now resolve.
    const add = referencesTo(db, "add");
    expect(add.definedIn).toBe("src/store.ts");
    expect(add.total).toBe(2);
    expect(add.files).toEqual(["src/app.ts"]);

    const size = referencesTo(db, "size");
    expect(size.total).toBe(2);
    expect(size.files.sort()).toEqual(["src/app.ts", "src/reset.ts"]);

    // And it keeps what the fast pass already had right.
    expect(referencesTo(db, "makeStore").total).toBe(2);
  });

  it("resolves type positions, which carry no runtime identifier", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    resolveTypes(db, root);

    // `Store` appears as a return type annotation in store.ts and as the
    // inferred type elsewhere; the class is referenced, not just imported.
    const store = referencesTo(db, "Store");
    expect(store.definedIn).toBe("src/store.ts");
    expect(store.total).toBeGreaterThan(0);
  });

  it("survives a later scan", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    resolveTypes(db, root);
    expect(referencesTo(db, "add").total).toBe(2);

    // The import resolver used to run over every ref row, fail to resolve the
    // marker the typed pass writes as a module path, and null out its targets —
    // so typed precision silently vanished on the very next scan, even when
    // nothing had changed.
    await scan(root, { kind: "incremental" });
    expect(referencesTo(db, "add").total).toBe(2);

    // Re-parsing a file legitimately invalidates its typed refs: the line
    // numbers they carry are no longer trustworthy. Precision is expected to
    // drop here and to come back when the typed pass runs again — which is
    // what the daemon schedules after any scan.
    await scan(root, { kind: "full", full: true });
    if (hasNative) expect(referencesTo(db, "add").total).toBe(0);

    resolveTypes(db, root);
    expect(referencesTo(db, "add").total).toBe(2);
  });

  it("reports honestly when there is no TypeScript project", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "py", version: "1.0.0" }),
      "src/main.py": "def go():\n    return 1\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const result = resolveTypes(db, root);
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/tsconfig/i);
    expect(result.resolved).toBe(0);
  });
});

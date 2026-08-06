import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { referencesTo } from "../graph/refs.js";
import {
  analyseTypes,
  applyTypedAnalysis,
  resolveTypes,
  resolveTypesInWorker,
  typedWorkspaceGeneration,
} from "../graph/typed.js";
import { neighbourhood } from "../memory/context.js";
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

  it("keeps destinations declared in repository-owned declaration files", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "declarations", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/types.d.ts": "export interface User { id: string }\n",
      "src/app.ts": "import type { User } from './types.js';\nexport const id = (user: User) => user.id;\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    resolveTypes(db, root);

    expect(referencesTo(db, "User").definedIn).toBe("src/types.d.ts");
    expect(referencesTo(db, "User").files).toEqual(["src/app.ts"]);
  });

  it("tracks arbitrary repository configs reached through extends", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "extended-config", type: "module" }),
      "config/base.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
      }),
      "tsconfig.json": JSON.stringify({ extends: "./config/base.json", include: ["src/**/*"] }),
      "src/app.ts": "export const value = 1;\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const analysis = analyseTypes(root);
    const result = resolveTypes(db, root);

    expect(result.ran).toBe(true);
    expect(analysis.inputs.map((input) => input.path)).toContain("config/base.json");
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

  it("does not start typed work after its workspace lifecycle was cancelled", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const controller = new AbortController();
    controller.abort();

    await expect(resolveTypesInWorker(db, root, controller.signal)).rejects.toThrow(/cancelled/i);
  });

  it("analyses referenced packages when the root config also owns files", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "mixed-root", private: true }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
        references: [{ path: "./packages/core" }],
      }),
      "src/root.ts": "export function rootEntry() { return 1; }\n",
      "packages/core/tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          composite: true,
        },
        include: ["src/**/*"],
      }),
      "packages/core/src/store.ts": `
export class Store { add(value: string): string { return value; } }
export function makeStore(): Store { return new Store(); }
`,
      "packages/core/src/app.ts": `
import { makeStore } from "./store.js";
export function packageEntry() { return makeStore().add("ok"); }
`,
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const result = resolveTypes(db, root);
    expect(result.ran).toBe(true);
    expect(referencesTo(db, "add").callSites).toEqual([
      expect.objectContaining({ path: "packages/core/src/app.ts", line: 3 }),
    ]);
  });

  it("retains independently configured packages when the root also owns files", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "independent-packages", private: true }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/root.ts": "export const rootValue = 1;\n",
      "packages/core/tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "packages/core/src/store.ts":
        "export class Store { add(value: string): string { return value; } }\n",
      "packages/core/src/app.ts":
        "import { Store } from './store.js';\nexport const run = () => new Store().add('ok');\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const result = resolveTypes(db, root);
    expect(result.ran).toBe(true);
    expect(referencesTo(db, "add").callSites).toEqual([
      expect.objectContaining({ path: "packages/core/src/app.ts", line: 2 }),
    ]);
  });

  it("rejects a worker generation when an overlapping scan adds an input", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "generation-fence", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/foo/index.ts": "export function value(): number { return 1; }\n",
      "src/app.ts": "import { value } from './foo.js';\nexport const current = value();\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const analysis = {
      ...analyseTypes(root),
      workspaceGeneration: typedWorkspaceGeneration(db),
    };

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/foo.ts"), "export function value(): number { return 2; }\n");
    await scan(root, { kind: "incremental" });

    const result = applyTypedAnalysis(db, analysis);
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/workspace inputs changed/i);
  });

  it("keeps same-line same-name references when they resolve to different destinations", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "same-line-members", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/a.ts": "export class A { run(): string { return 'a'; } }\n",
      "src/b.ts": "export class B { run(): string { return 'b'; } }\n",
      "src/app.ts": `import { A } from "./a.js"; import { B } from "./b.js";\nexport function both() { const a = new A(); const b = new B(); return a.run() + b.run(); }\n`,
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    resolveTypes(db, root);
    const destinations = db
      .all<{ dst_path: string }>(
        "SELECT dst_path FROM refs WHERE src_path = 'src/app.ts' AND name = 'run' ORDER BY dst_path",
      )
      .map((row) => row.dst_path);
    expect(destinations).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keeps repeated uses of the same declaration on one physical line", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "same-line-occurrences", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/store.ts": "export class Store { add(value: string): string { return value; } }\n",
      "src/app.ts": `import { Store } from "./store.js";\nexport function both() { const store = new Store(); store.add("a"); store.add("b"); }\n`,
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    resolveTypes(db, root);

    const refs = referencesTo(db, "add");
    expect(refs.total).toBe(2);
    expect(new Set(refs.callSites.map((site) => site.column)).size).toBe(2);
  });

  it("requires declaration identity when one file has duplicate method names", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "ambiguous-members", type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*"],
      }),
      "src/models.ts": `export class A { run(): string { return "a"; } }\nexport class B { run(): string { return "b"; } }\n`,
      "src/app.ts": `import { A, B } from "./models.js";\nexport function both() { return new A().run() + new B().run(); }\n`,
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    resolveTypes(db, root);

    const ambiguous = referencesTo(db, "run");
    expect(ambiguous.definedIn).toBeNull();
    expect(ambiguous.total).toBe(0);
    expect(ambiguous.candidates).toHaveLength(2);
    expect(referencesTo(db, "run", 100, { path: "src/models.ts" }).definedIn).toBeNull();

    const first = ambiguous.candidates?.[0];
    expect(first).toBeDefined();
    expect(referencesTo(db, "run", 100, { symbolId: first!.symbolId }).total).toBe(1);

    const context = neighbourhood(db, "src/models.ts");
    expect(
      context.symbols.filter((symbol) => symbol.name === "run").map((symbol) => symbol.references),
    ).toEqual([1, 1]);
  });
});

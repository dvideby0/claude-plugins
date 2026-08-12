import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { neighbourhood } from "../memory/context.js";
import { forget, listMemories, memoriesForPath, recall, remember } from "../memory/store.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/core/db.ts": `
export function connect(url: string) { return { url }; }
export function query(sql: string) { return sql; }
`,
  "src/api/users.ts": `
import { query } from "../core/db";
export function getUser(id: string) { return query("SELECT 1" + id); }
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("memory", () => {
  it("records, updates in place, and supersedes", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const first = remember(db, {
      kind: "decision",
      title: "Use sql.js rather than a native driver",
      body: "Plugins cannot ship native modules.",
      anchors: [{ path: "src/core/db.ts" }],
    });
    expect(first.created).toBe(true);

    // The same decision recorded again updates rather than duplicating.
    const second = remember(db, {
      kind: "decision",
      title: "use SQL.JS rather than a native driver",
      body: "Superseded reasoning.",
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(listMemories(db).length).toBe(1);
    expect(listMemories(db)[0]?.body).toBe("Superseded reasoning.");

    // Updating only where the note applies must not erase why it exists.
    remember(db, {
      kind: "decision",
      title: "use SQL.JS rather than a native driver",
      anchors: [{ path: "src/api/users.ts" }],
    });
    expect(listMemories(db)[0]?.body).toBe("Superseded reasoning.");
    expect(listMemories(db)[0]?.anchors[0]?.path).toBe("src/api/users.ts");

    expect(forget(db, first.id)).toBe(true);
    expect(listMemories(db).length).toBe(0);
    expect(forget(db, "nope")).toBe(false);
  });

  it("surfaces anchored memories through context", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    remember(db, {
      kind: "constraint",
      title: "Never interpolate into query()",
      body: "It does no escaping.",
      anchors: [{ path: "src/core/db.ts", symbol: "query" }],
    });

    const view = neighbourhood(db, "db.ts");
    expect(view.resolved).toBe("src/core/db.ts");
    expect(view.memories.map((memory) => memory.title)).toContain(
      "Never interpolate into query()",
    );
    expect(view.importers).toContain("src/api/users.ts");

    // An importer inherits it as nearby context — usually why the file exists.
    const importer = neighbourhood(db, "src/api/users.ts");
    expect(importer.memories).toHaveLength(0);
    expect(importer.nearbyMemories.map((memory) => memory.title)).toContain(
      "Never interpolate into query()",
    );
  });

  it("flags a memory whose file has changed since it was written", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    remember(db, {
      kind: "gotcha",
      title: "connect() does not validate the url",
      anchors: [{ path: "src/core/db.ts" }],
    });
    expect(memoriesForPath(db, "src/core/db.ts")[0]?.anchors[0]?.stale).toBe(false);

    await writeFile(join(root, "src/core/db.ts"), "export function connect() { return null; }\n");
    await scan(root, { kind: "incremental" });

    expect(memoriesForPath(db, "src/core/db.ts")[0]?.anchors[0]?.stale).toBe(true);
  });

  it("ranks recall by where the terms match", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    remember(db, { kind: "decision", title: "Retry policy for uploads", body: "Three attempts." });
    remember(db, { kind: "context", title: "Unrelated note", body: "Mentions retry once." });

    const hits = recall(db, "retry");
    expect(hits.length).toBe(2);
    // A title match outranks a body mention.
    expect(hits[0]?.title).toBe("Retry policy for uploads");
    expect(recall(db, "retry", 20, "decision").map((memory) => memory.kind)).toEqual([
      "decision",
    ]);

    expect(recall(db, "nothing-matches-this")).toHaveLength(0);
  });

  it("filters memory subtypes before the ranked result limit", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    for (let index = 0; index < 101; index++) {
      remember(db, {
        kind: "context",
        title: `Shared recall phrase ${index}`,
        body: "Context that should not satisfy a decision-only recall.",
      });
    }
    remember(db, {
      kind: "decision",
      title: "The one applicable decision",
      body: "Shared recall phrase",
    });

    expect(recall(db, "shared recall phrase", 20, "decision").map((memory) => memory.title))
      .toEqual(["The one applicable decision"]);
  });

  it("resolves an ambiguous name to candidates instead of guessing", async () => {
    root = await makeProject({
      ...PROJECT,
      "src/api/index.ts": "export const a = 1;\n",
      "src/core/index.ts": "export const b = 2;\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const view = neighbourhood(db, "index.ts");
    expect(view.candidates?.length).toBe(2);
    expect(view.resolved).toBeNull();
    expect(view.file).toBeNull();
    expect(view.symbols).toHaveLength(0);
    expect(neighbourhood(db, "does-not-exist.ts").kind).toBe("unknown");
  });
});

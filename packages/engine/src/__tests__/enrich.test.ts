import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { findGaps } from "../graph/gaps.js";
import { markExplored, relate, relationsFor } from "../graph/relations.js";
import { remember } from "../memory/store.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

/** A framework that registers handlers as data — invisible to any parser. */
const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/graph.py": `
from .nodes import classify_node, research_node

def build(b):
    b.add_node("classify", classify_node)
    b.add_node("research", research_node)
    b.add_edge("classify", "research")
    return b
`,
  "src/nodes.py": `
def classify_node(state):
    return state

def research_node(state):
    return state
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("enrichment", () => {
  it("flags a wiring file the parser cannot follow", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const { gaps } = findGaps(db);
    const dispatch = gaps.find((gap) => gap.kind === "dynamic-dispatch");
    expect(dispatch?.path).toBe("src/graph.py");
    // Naming is the signal that survives: the add_node calls live inside
    // build(), so no symbol signature mentions them.
    expect(dispatch?.hint).toMatch(/registration/i);
  });

  it("refuses a relation with no evidence", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(() =>
      relate(db, {
        kind: "registers",
        srcPath: "src/graph.py",
        evidence: "   ",
      }),
    ).toThrow(/Evidence is required/);
  });

  it("records an edge the parser could not derive, with its citation", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const first = relate(db, {
      kind: "registers",
      srcPath: "src/graph.py",
      srcSymbol: "build",
      dstPath: "src/nodes.py",
      dstSymbol: "classify_node",
      label: "classify",
      evidence: 'b.add_node("classify", classify_node)',
      evidenceLine: 5,
      confidence: "definite",
    });
    expect(first.created).toBe(true);

    // Re-recording the same edge updates it rather than duplicating.
    expect(relate(db, {
      kind: "registers",
      srcPath: "src/graph.py",
      srcSymbol: "build",
      dstPath: "src/nodes.py",
      dstSymbol: "classify_node",
      label: "classify",
      evidence: 'b.add_node("classify", classify_node)  # unchanged',
    }).created).toBe(false);

    const found = relationsFor(db, "src/graph.py");
    expect(found).toHaveLength(1);
    expect(found[0]?.stale).toBe(false);
    expect(found[0]?.evidence).toContain("add_node");
  });

  it("flags a relation whose source file has changed since", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    relate(db, {
      kind: "registers",
      srcPath: "src/graph.py",
      dstPath: "src/nodes.py",
      dstSymbol: "classify_node",
      evidence: 'b.add_node("classify", classify_node)',
    });

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/graph.py"), "def build(b):\n    return b\n");
    await scan(root, { kind: "incremental" });

    expect(relationsFor(db, "src/graph.py")[0]?.stale).toBe(true);
  });

  it("flags relations and notes whose source file was deleted", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    relate(db, {
      kind: "registers",
      srcPath: "src/graph.py",
      dstPath: "src/nodes.py",
      dstSymbol: "classify_node",
      evidence: 'b.add_node("classify", classify_node)',
    });
    remember(db, {
      kind: "gotcha",
      title: "Graph registration order matters",
      anchors: [{ path: "src/graph.py" }],
    });

    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(root, "src/graph.py"));
    await scan(root, { kind: "incremental" });

    expect(relationsFor(db, "src/graph.py")[0]?.stale).toBe(true);
    expect(findGaps(db).gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stale-note", path: "src/graph.py" }),
      ]),
    );
  });

  it("counts exploration only while the file is unchanged", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    expect(findGaps(db).coverage.explored).toBe(0);
    markExplored(db, "src/graph.py", 2, "two registrations");
    expect(findGaps(db).coverage.explored).toBe(1);

    // A changed file is unexplored again — the note was about the old code.
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/graph.py"), "def build(b):\n    return b  # changed\n");
    await scan(root, { kind: "incremental" });
    expect(findGaps(db).coverage.explored).toBe(0);
  });

  it("stops reporting orphans once a relation explains them", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    relate(db, {
      kind: "registers",
      srcPath: "src/graph.py",
      dstPath: "src/nodes.py",
      dstSymbol: "classify_node",
      evidence: 'b.add_node("classify", classify_node)',
    });
    relate(db, {
      kind: "registers",
      srcPath: "src/graph.py",
      dstPath: "src/nodes.py",
      dstSymbol: "research_node",
      evidence: 'b.add_node("research", research_node)',
    });

    const orphans = findGaps(db).gaps.filter((gap) => gap.kind === "orphan-entry");
    expect(orphans.find((gap) => gap.path === "src/nodes.py")).toBeUndefined();
  });
});

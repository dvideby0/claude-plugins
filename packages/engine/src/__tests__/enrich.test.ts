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
    expect(() =>
      relate(db, {
        kind: "registers",
        srcPath: "src/graph.py",
        evidence: 'b.add_node("classify", classify_node)',
        evidenceLine: -1,
      }),
    ).toThrow(/Evidence line must be an integer between/);
  });

  it("treats a relation without an indexed source snapshot as stale", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    relate(db, {
      kind: "registers",
      srcPath: "src/missing.py",
      dstPath: "src/nodes.py",
      evidence: "configuration names classify_node",
    });

    expect(relationsFor(db, "src/missing.py")[0]?.stale).toBe(true);
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

  it("reopens orphan gaps when the relations that explained them go stale", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    for (const name of ["classify_node", "research_node"]) {
      relate(db, {
        kind: "registers",
        srcPath: "src/graph.py",
        dstPath: "src/nodes.py",
        dstSymbol: name,
        evidence: `b.add_node("${name}", ${name})`,
      });
    }
    expect(findGaps(db).gaps.some((gap) => gap.path === "src/nodes.py")).toBe(false);

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/graph.py"), "def build(b):\n    return b\n");
    await scan(root, { kind: "incremental" });

    expect(findGaps(db).gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "orphan-entry", path: "src/nodes.py" }),
      ]),
    );
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
    // A deleted file is an orphan, not a note recorded against an older
    // version of something that still exists — and the relation is reported
    // too, which the file-changed path never covered.
    const gaps = findGaps(db).gaps;
    expect(gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "orphan-anchor", path: "src/graph.py" }),
      ]),
    );
    expect(gaps.filter((gap) => gap.kind === "orphan-anchor").length).toBeGreaterThan(1);
  });

  it("queues a memory recorded before its anchor was indexed for validation", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    remember(db, {
      kind: "gotcha",
      title: "Future worker has a hidden constraint",
      anchors: [{ path: "src/future.py" }],
    });

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/future.py"), "def work():\n    return 1\n");
    await scan(root, { kind: "incremental" });

    expect(findGaps(db).gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stale-note", path: "src/future.py" }),
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

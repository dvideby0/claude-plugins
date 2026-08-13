import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  closeDb,
  getDb,
  type Db,
  type ExecutionFlowView,
} from "../db/db.js";
import { scan } from "../scan/scan.js";
import { loadNative, sourcePathDecision } from "../scan/source.js";

const withNative = loadNative() ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const routeSource = "packages/engine/src/daemon/http.ts";

type SelectedFlow = NonNullable<ExecutionFlowView["selected"]>;

function selectedFlow(db: Db, label: string): SelectedFlow {
  const matches = db.executionFlow().entries.filter((entry) => entry.label === label);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} entry, found ${matches.length}.`);
  }
  const selected = db.executionFlow(matches[0].id).selected;
  if (!selected) throw new Error(`Could not select ${label}.`);
  return selected;
}

function pathShapes(selected: SelectedFlow) {
  return selected.paths
    .map((path) => ({
      terminalEffect: path.terminalEffect,
      conditions: path.conditions,
      complete: path.complete,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expectedPaths(
  paths: Array<{ terminalEffect: string; conditions: string[]; complete: boolean }>,
) {
  return paths.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expectEvidenceAndProvenance(selected: SelectedFlow): void {
  expect(selected.entry).toMatchObject({
    path: routeSource,
    freshness: "current",
    certainty: "inferred",
    producer: {
      id: "sdlc-http-route-adapter",
      version: "7",
      kind: "framework",
    },
  });
  expect(selected.nodes.length).toBeGreaterThan(1);
  for (const node of selected.nodes) {
    expect(node.evidence.path).toBe(routeSource);
    expect(node.evidence.startLine).toBeGreaterThan(0);
    expect(node.evidence.endLine).toBeGreaterThanOrEqual(node.evidence.startLine);
    expect(node.certainty).toBe("inferred");
  }
  for (const edge of selected.edges) {
    expect(edge.evidence.path).toBe(routeSource);
    expect(edge.evidence.startLine).toBeGreaterThan(0);
    expect(edge.certainty).toBe("inferred");
  }
}

withNative("repository HTTP flow dogfood", () => {
  afterAll(async () => {
    await closeDb(repositoryRoot);
  });

  it("keeps three real daemon entries evidence-backed and honest about unresolved dispatch", async () => {
    const result = await scan(repositoryRoot, { full: true, kind: "repository-flow-dogfood" });
    expect(result.executionEntries).toBeGreaterThanOrEqual(12);

    const db = await getDb(repositoryRoot);
    const search = selectedFlow(db, "GET /api/search");
    const watch = selectedFlow(db, "ANY /api/watch");
    const addWorkspace = selectedFlow(db, "POST /api/workspaces");

    for (const selected of [search, watch, addWorkspace]) {
      expectEvidenceAndProvenance(selected);
      expect(selected.truncated).toBe(false);
    }

    expect(search.entry).toMatchObject({ terminalEffects: 3, gaps: 1 });
    expect(pathShapes(search)).toEqual(
      expectedPaths([
        {
          terminalEffect: "http:response:400",
          conditions: ["try block throws"],
          complete: true,
        },
        {
          terminalEffect: "http:response:400",
          conditions: ["when (!CROSS_KINDS.includes(kind))"],
          complete: true,
        },
        {
          terminalEffect: "http:response:200",
          conditions: ["otherwise ((!CROSS_KINDS.includes(kind)))"],
          complete: false,
        },
      ]),
    );
    expect(search.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Call normalizeSearchQuery",
          resolution: "resolved",
          target: expect.objectContaining({
            path: "packages/engine/src/graph/cross.ts",
            symbol: "normalizeSearchQuery",
          }),
        }),
        expect.objectContaining({
          label: "Await crossQuery",
          resolution: "resolved",
          target: expect.objectContaining({
            path: "packages/engine/src/graph/cross.ts",
            symbol: "crossQuery",
          }),
        }),
        expect.objectContaining({ label: "Await registry.list", resolution: "unresolved" }),
      ]),
    );
    expect(search.diagnostics).toEqual([
      expect.stringContaining("cannot resolve the target of Await registry.list"),
    ]);

    expect(watch.entry).toMatchObject({ terminalEffects: 1, gaps: 3 });
    expect(pathShapes(watch)).toEqual(
      expectedPaths([
        {
          terminalEffect: "http:response:200",
          conditions: ["when (method === \"POST\")"],
          complete: false,
        },
        {
          terminalEffect: "http:response:200",
          conditions: ["otherwise ((method === \"POST\"))"],
          complete: true,
        },
      ]),
    );
    expect(
      watch.nodes
        .filter((node) => node.resolution === "unresolved")
        .map((node) => node.label),
    ).toEqual(["Await readBody", "Await syncWatchers", "Call log"]);

    expect(addWorkspace.entry).toMatchObject({ terminalEffects: 3, gaps: 4 });
    expect(pathShapes(addWorkspace)).toEqual(
      expectedPaths([
        {
          terminalEffect: "http:response:400",
          conditions: ["when (!body?.root)"],
          complete: false,
        },
        {
          terminalEffect: "http:response:400",
          conditions: [
            "otherwise ((!body?.root))",
            "when (!isWorkspaceDirectory(body.root))",
          ],
          complete: false,
        },
        {
          terminalEffect: "http:response:201",
          conditions: [
            "otherwise ((!body?.root))",
            "otherwise ((!isWorkspaceDirectory(body.root)))",
          ],
          complete: false,
        },
      ]),
    );
    expect(
      addWorkspace.nodes
        .filter((node) => node.resolution === "unresolved")
        .map((node) => node.label),
    ).toEqual([
      "Await readBody",
      "Call isWorkspaceDirectory",
      "Await registry.add",
      "Await syncWatchers",
    ]);
  });
  /**
   * Locking this repository's own input boundary.
   *
   * Asserting that `release/` is absent would pass vacuously — it is gitignored,
   * so a fresh clone or a CI runner never has one. The invariant is what
   * actually holds: every path in the index is a path the shared policy would
   * admit. That would have failed on the leaked `preload.cjs`, and it cannot
   * pass by accident.
   *
   * It lives beside the flow dogfood because both need this repository scanned
   * into one store, and two test files racing for it is a conflict, not a test.
   */
  it("indexes only paths the shared input policy admits", async () => {
    const db = await getDb(repositoryRoot);
    const indexed = db
      .all<{ path: string }>("SELECT path FROM files WHERE present = 1 ORDER BY path")
      .map((row) => row.path);

    expect(indexed.length).toBeGreaterThan(0);
    const shouldNotBeIndexed = indexed.filter(
      (path) => !sourcePathDecision(path, repositoryRoot, false).included,
    );
    expect(shouldNotBeIndexed).toEqual([]);
  });
});

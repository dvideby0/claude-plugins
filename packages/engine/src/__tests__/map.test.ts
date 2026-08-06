import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import {
  componentDetail,
  componentOf,
  describeComponent,
  describeFlow,
  finalizeMap,
  mapDrift,
  systemMap,
  tagNode,
} from "../graph/map.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/api/routes.py": "def handle():\n    return 1\n",
  "src/api/auth.py": "def check():\n    return True\n",
  "src/core/db.py": "def query(sql):\n    return sql\n",
  "src/loose.py": "def stray():\n    return 0\n",
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("the drawn map", () => {
  it("nests boxes and counts what is really inside them", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "App", kind: "system", summary: "The whole thing." });
    describeComponent(db, { name: "API", kind: "layer", parent: "App", members: ["src/api/"] });
    describeComponent(db, { name: "Core", kind: "layer", parent: "App", members: ["src/core/"] });

    const map = systemMap(db);
    const api = map.components.find((component) => component.name === "API");
    expect(api?.fileCount).toBe(2);
    expect(api?.parent).toBe(map.components.find((c) => c.name === "App")?.id);
    expect(map.components.find((c) => c.name === "App")?.children).toHaveLength(2);

    // A grouping box owns no files itself; it should still report the weight
    // of what is inside it, counted once even where children overlap.
    const app = map.components.find((c) => c.name === "App")!;
    expect(app.fileCount).toBe(0);
    expect(app.rollupFiles).toBe(3);

    // Coverage is the honest number: src/loose.py belongs to no box.
    expect(map.coverage.total).toBe(4);
    expect(map.coverage.assigned).toBe(3);
    expect(map.coverage.unassigned).toContain("src/loose.py");
  });

  it("places flow steps in the box they happen in", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "API", members: ["src/api/"] });
    describeComponent(db, { name: "Core", members: ["src/core/"] });
    describeFlow(db, {
      name: "Request",
      trigger: "An HTTP call",
      steps: [
        { label: "Authenticate", path: "src/api/auth.py", symbol: "check" },
        { label: "Handle", path: "src/api/routes.py", symbol: "handle" },
        { label: "Read data", path: "src/core/db.py", symbol: "query", note: "No caching yet." },
      ],
    });

    const flow = systemMap(db).flows[0];
    expect(flow?.steps.map((step) => step.component)).toEqual(["API", "API", "Core"]);
    expect(flow?.steps.every((step) => step.resolves)).toBe(true);
  });

  it("marks a step whose file has gone", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeFlow(db, {
      name: "Request",
      steps: [{ label: "Read data", path: "src/core/db.py", symbol: "query" }],
    });

    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(root, "src/core/db.py"));
    await scan(root, { kind: "incremental" });

    expect(systemMap(db).flows[0]?.steps[0]?.resolves).toBe(false);
  });

  it("drifts only the box whose files moved", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "API", members: ["src/api/"] });
    describeComponent(db, { name: "Core", members: ["src/core/"] });
    finalizeMap(db, { acknowledgeUnassigned: ["src/loose.py"] });
    expect(mapDrift(db).clean).toBe(true);

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/api/auth.py"), "def check():\n    return False  # changed\n");
    await scan(root, { kind: "incremental" });

    // The whole point: one box needs redrawing, not the repository.
    const drift = mapDrift(db);
    expect(drift.clean).toBe(false);
    expect(drift.components.map((component) => component.name)).toEqual(["API"]);
    // Names the file that moved, not every file in the box — that is the
    // difference between "redraw this component" and "re-read one file".
    expect(drift.components[0]?.changedFiles).toEqual(["src/api/auth.py"]);
  });

  it("preserves drift when only component metadata or layout is updated", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    describeComponent(db, { name: "API", summary: "Request handling.", members: ["src/api/"] });

    await writeFile(join(root, "src/api/auth.py"), "def check():\n    return False  # changed\n");
    await scan(root, { kind: "incremental" });
    expect(mapDrift(db).components).toHaveLength(1);

    describeComponent(db, { name: "API", summary: "Public request handling.", ordinal: 2 });
    expect(mapDrift(db).components[0]?.changedFiles).toEqual(["src/api/auth.py"]);
  });

  it("drifts a box when a file is added to it, not just edited", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "Core", members: ["src/core/"] });
    finalizeMap(db, {
      acknowledgeUnassigned: ["src/api/routes.py", "src/api/auth.py", "src/loose.py"],
    });
    expect(mapDrift(db).clean).toBe(true);

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/core/cache.py"), "def get(k):\n    return None\n");
    await scan(root, { kind: "incremental" });

    const drift = mapDrift(db);
    expect(drift.components.map((c) => c.name)).toEqual(["Core"]);
    expect(drift.components[0]?.changedFiles).toEqual(["src/core/cache.py (added)"]);
  });

  it("drifts a flow when a step's file changes", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeFlow(db, {
      name: "Request",
      steps: [{ label: "Read data", path: "src/core/db.py", symbol: "query" }],
    });
    expect(mapDrift(db).flows).toHaveLength(0);

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, "src/core/db.py"), "def query(sql):\n    return sql.upper()\n");
    await scan(root, { kind: "incremental" });

    expect(mapDrift(db).flows[0]?.name).toBe("Request");
  });

  it("tags cut across components", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "API", members: ["src/api/"] });
    tagNode(db, { tag: "entrypoint", path: "src/api/routes.py", symbol: "handle", description: "Where a request arrives." });
    tagNode(db, { tag: "entrypoint", path: "src/core/db.py" });

    const map = systemMap(db);
    expect(map.tags.find((tag) => tag.name === "entrypoint")?.count).toBe(2);
    expect(map.components.find((c) => c.name === "API")?.tags).toContain("entrypoint");
  });

  it("refuses a flow with no steps", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    expect(() => describeFlow(db, { name: "Empty", steps: [] })).toThrow(/needs steps/);
  });

  it("preserves authored flow metadata when only its steps are refreshed", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeFlow(db, {
      name: "Request",
      summary: "The public request path.",
      trigger: "An HTTP call",
      steps: [{ label: "Authenticate", path: "src/api/auth.py" }],
    });
    describeFlow(db, {
      name: "Request",
      steps: [{ label: "Handle", path: "src/api/routes.py" }],
    });

    const flow = systemMap(db).flows[0];
    expect(flow?.summary).toBe("The public request path.");
    expect(flow?.trigger).toBe("An HTTP call");
    expect(flow?.steps[0]?.label).toBe("Handle");
  });

  it("rejects indirect component-parent cycles", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const app = describeComponent(db, { name: "App" });
    describeComponent(db, { name: "API", parent: "App" });
    expect(() => describeComponent(db, { name: "App", parent: "API" })).toThrow(/ancestor/);
    expect(systemMap(db).components.find((component) => component.name === "API")?.parent)
      .toBe(app.id);
  });

  it("moves an existing nested component back to the root explicitly", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "App" });
    describeComponent(db, { name: "API", parent: "App" });
    describeComponent(db, { name: "API", parent: null });

    expect(systemMap(db).components.find((component) => component.name === "API")?.parent)
      .toBeNull();
  });

  it("finds a newly unassigned file beyond the map display cap", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [
        `src/loose-${String(index).padStart(2, "0")}.py`,
        `value = ${index}\n`,
      ]),
    );
    root = await makeProject({
      ...files,
      "src/core/main.py": "def run():\n    return 1\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    describeComponent(db, { name: "Core", members: ["src/core/"] });
    finalizeMap(db, { acknowledgeUnassigned: Object.keys(files) });

    await writeFile(join(root, "src/zzz-new.py"), "value = 99\n");
    await scan(root, { kind: "incremental" });

    expect(systemMap(db).coverage.unassigned).toHaveLength(40);
    expect(systemMap(db).coverage.unassigned).not.toContain("src/zzz-new.py");
    expect(mapDrift(db).newlyUnassigned).toContain("src/zzz-new.py");
  });

  it("keeps unassigned drift through metadata edits until explicitly acknowledged", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    describeComponent(db, { name: "API", members: ["src/api/"] });
    finalizeMap(db, { acknowledgeUnassigned: ["src/core/db.py", "src/loose.py"] });

    await writeFile(join(root, "src/new-worker.py"), "def work():\n    return 1\n");
    await scan(root, { kind: "incremental" });
    expect(mapDrift(db).newlyUnassigned).toContain("src/new-worker.py");

    describeComponent(db, { name: "API", summary: "Updated prose only." });
    expect(mapDrift(db).newlyUnassigned).toContain("src/new-worker.py");

    describeComponent(db, { name: "API", acknowledgeUnassigned: ["src/new-worker.py"] });
    expect(mapDrift(db).newlyUnassigned).not.toContain("src/new-worker.py");
  });

  it("keeps an interrupted first drawing resumable until explicitly finalized", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "App", kind: "system", members: ["src/"] });
    expect(mapDrift(db)).toMatchObject({ complete: false, clean: false });

    finalizeMap(db);
    expect(mapDrift(db)).toMatchObject({ complete: true, clean: true });
  });

  it("refuses to finalize while unexplained files remain unacknowledged", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    describeComponent(db, { name: "API", members: ["src/api/"] });

    expect(() => finalizeMap(db)).toThrow(/unexplained file/);
    expect(mapDrift(db).complete).toBe(false);
  });
});

describe("crossing between the two maps", () => {
  it("opens a box onto the files, flows and notes underneath it", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "API", kind: "layer", summary: "Edge.", members: ["src/api/"] });
    tagNode(db, { path: "src/api/routes.py", tag: "entrypoint" });
    describeFlow(db, {
      name: "Request",
      summary: "One request.",
      steps: [
        { label: "Take the request", path: "src/api/routes.py", symbol: "handle" },
        { label: "Check the caller", path: "src/api/auth.py", symbol: "check" },
        { label: "Read the row", path: "src/core/db.py", symbol: "query" },
      ],
    });

    const id = systemMap(db).components[0]!.id;
    const detail = componentDetail(db, id)!;

    expect(detail.files.map((file) => file.path).sort()).toEqual([
      "src/api/auth.py",
      "src/api/routes.py",
    ]);
    expect(detail.files.find((file) => file.path === "src/api/routes.py")?.tags).toContain(
      "entrypoint",
    );

    // Only the steps that land in this box, so the drawer reflects the box.
    expect(detail.flows).toHaveLength(1);
    expect(detail.flows[0]?.steps).toEqual(["Take the request", "Check the caller"]);
  });

  it("says which box a file sits in, including through a prefix", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "App", kind: "system", members: ["src/"] });
    describeComponent(db, { name: "API", kind: "layer", parent: "App", members: ["src/api/"] });

    // Prefix members are patterns rather than rows, so this has to expand them
    // rather than look for a matching path.
    //
    // Both boxes contain src/api/auth.py. The nested one is the useful answer:
    // "in App" is true of nearly everything and tells a reader nothing.
    expect(componentOf(db, "src/api/auth.py")?.name).toBe("API");
    expect(componentOf(db, "src/core/db.py")?.name).toBe("App");
    expect(componentOf(db, "package.json")).toBeNull();
  });

  it("marks a file as changed since the box was drawn", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    describeComponent(db, { name: "API", kind: "layer", members: ["src/api/"] });
    const id = systemMap(db).components[0]!.id;

    expect(componentDetail(db, id)!.files.every((file) => !file.changed)).toBe(true);

    await writeFile(join(root, "src/api/auth.py"), "def check():\n    return False\n");
    await scan(root, { kind: "incremental" });

    const files = componentDetail(db, id)!.files;
    expect(files.find((file) => file.path === "src/api/auth.py")?.changed).toBe(true);
    expect(files.find((file) => file.path === "src/api/routes.py")?.changed).toBe(false);
  });
});

describe("rolling counts up the tree", () => {
  it("counts a shared file once rather than once per box", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    describeComponent(db, { name: "App", kind: "system" });
    describeComponent(db, { name: "API", kind: "layer", parent: "App", members: ["src/api/"] });
    // Overlaps API deliberately — a shared box is a legitimate thing to draw,
    // and summing the child counts would claim more files than exist.
    describeComponent(db, {
      name: "Shared",
      kind: "layer",
      parent: "App",
      members: ["src/api/auth.py", "src/core/"],
    });

    const map = systemMap(db);
    const app = map.components.find((component) => component.name === "App")!;
    expect(app.rollupFiles).toBe(3);
    expect(map.components.find((c) => c.name === "API")!.fileCount).toBe(2);
    expect(map.components.find((c) => c.name === "Shared")!.fileCount).toBe(2);
  });
});

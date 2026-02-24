import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDepGraph } from "../../scripts/build-dep-graph.js";
import {
  createTestProject,
  copyFixture,
  type TestProject,
} from "../helpers.js";
import type { DependencyData } from "../../lib/types.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

describe("buildDepGraph", () => {
  it("builds graph with correct fan-in and fan-out", async () => {
    project = await createTestProject();

    // src_auth → src_utils, src_api → [src_utils, src_auth]
    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    // src_utils: fan_in=2 (auth+api depend on it), fan_out=0
    expect(data.module_graph["src_utils"].fan_in).toBe(2);
    expect(data.module_graph["src_utils"].fan_out).toBe(0);
    expect(data.module_graph["src_utils"].depends_on).toEqual([]);

    // src_auth: fan_in=1 (api depends on it), fan_out=1 (depends on utils)
    expect(data.module_graph["src_auth"].fan_in).toBe(1);
    expect(data.module_graph["src_auth"].fan_out).toBe(1);
    expect(data.module_graph["src_auth"].depends_on).toEqual(["src_utils"]);

    // src_api: fan_in=0 (nobody depends on it), fan_out=2
    expect(data.module_graph["src_api"].fan_in).toBe(0);
    expect(data.module_graph["src_api"].fan_out).toBe(2);
    expect(data.module_graph["src_api"].depends_on).toEqual([
      "src_utils",
      "src_auth",
    ]);
  });

  it("computes reverse dependencies correctly", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    // src_utils is depended on by both src_auth and src_api
    expect(data.module_graph["src_utils"].depended_on_by).toHaveLength(2);
    expect(data.module_graph["src_utils"].depended_on_by).toContain("src_auth");
    expect(data.module_graph["src_utils"].depended_on_by).toContain("src_api");

    // src_auth is depended on by src_api
    expect(data.module_graph["src_auth"].depended_on_by).toEqual(["src_api"]);

    // src_api is not depended on by anyone
    expect(data.module_graph["src_api"].depended_on_by).toEqual([]);
  });

  it("detects direct cycles", async () => {
    project = await createTestProject();

    // cycle_a → cycle_b and cycle_b → cycle_a
    await copyFixture("src_cycle_a.json", project.modulesDir);
    await copyFixture("src_cycle_b.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    expect(data.circular_dependencies).toHaveLength(1);

    // Should be [smaller, larger, smaller] per the dedup logic
    const cycle = data.circular_dependencies[0];
    expect(cycle).toEqual(["src_cycle_a", "src_cycle_b", "src_cycle_a"]);
  });

  it("classifies orphan modules (fan_in=0, fan_out>0)", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    // src_api: fan_in=0, fan_out=2 → orphan
    expect(data.orphan_modules).toContain("src_api");

    // src_utils: fan_in=2, fan_out=0 → not orphan (fan_out=0 disqualifies)
    expect(data.orphan_modules).not.toContain("src_utils");

    // src_auth: fan_in=1 → not orphan
    expect(data.orphan_modules).not.toContain("src_auth");
  });

  it("builds external dependency inventory", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_api.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    // express is used by src_auth and src_api
    expect(data.external_dependencies["express"]).toHaveLength(2);
    expect(data.external_dependencies["express"]).toContain("src_auth");
    expect(data.external_dependencies["express"]).toContain("src_api");

    // lodash only by src_utils
    expect(data.external_dependencies["lodash"]).toEqual(["src_utils"]);

    // jsonwebtoken only by src_auth
    expect(data.external_dependencies["jsonwebtoken"]).toEqual(["src_auth"]);

    // cors only by src_api
    expect(data.external_dependencies["cors"]).toEqual(["src_api"]);
  });

  it("handles object-typed internal dependencies", async () => {
    project = await createTestProject();

    // src_obj_deps has { path: "src_utils" } and { module: "src_auth" }
    await copyFixture("src_obj_deps.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);
    await copyFixture("src_auth.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    expect(data.module_graph["src_obj_deps"].depends_on).toContain("src_utils");
    expect(data.module_graph["src_obj_deps"].depends_on).toContain("src_auth");
    expect(data.module_graph["src_obj_deps"].fan_out).toBe(2);
  });

  it("handles object-typed external dependencies", async () => {
    project = await createTestProject();

    // src_obj_deps has { name: "axios", version: "^1.6" } and "lodash"
    await copyFixture("src_obj_deps.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    expect(data.external_dependencies["axios"]).toEqual(["src_obj_deps"]);
    expect(data.external_dependencies["lodash"]).toEqual(["src_obj_deps"]);
  });

  it("handles slashed directory names", async () => {
    project = await createTestProject();

    // src_slash_dir has directory: "src/slash_dir"
    await copyFixture("src_slash_dir.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    expect(data.module_graph).toHaveProperty("src/slash_dir");
    expect(data.module_graph["src/slash_dir"].depends_on).toEqual([
      "src_utils",
    ]);
    expect(data.module_graph["src_utils"].depended_on_by).toContain(
      "src/slash_dir",
    );
  });

  it("handles module with missing directory field", async () => {
    project = await createTestProject();

    // src_no_dir.json has no "directory" field
    await copyFixture("src_no_dir.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    // Falls back to "unknown" for directory
    expect(data.module_graph).toHaveProperty("unknown");
  });

  it("handles self-referencing dependencies", async () => {
    project = await createTestProject();

    // src_self_ref depends on ["src_self_ref", "src_utils"]
    await copyFixture("src_self_ref.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);

    const { data } = await buildDepGraph(project.projectRoot);

    // Self-reference should be preserved in the graph
    expect(data.module_graph["src_self_ref"].depends_on).toContain(
      "src_self_ref",
    );
    expect(data.module_graph["src_self_ref"].depends_on).toContain("src_utils");

    // Self-reference counts as fan_in
    expect(data.module_graph["src_self_ref"].depended_on_by).toContain(
      "src_self_ref",
    );
  });

  it("returns empty result for empty modules directory", async () => {
    project = await createTestProject();

    const { data, summary } = await buildDepGraph(project.projectRoot);

    expect(Object.keys(data.module_graph)).toHaveLength(0);
    expect(data.circular_dependencies).toHaveLength(0);
    expect(data.hub_modules).toHaveLength(0);
    expect(data.orphan_modules).toHaveLength(0);
    expect(Object.keys(data.external_dependencies)).toHaveLength(0);
    expect(summary.modules).toBe(0);
  });

  it("writes output file to correct location", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);
    await copyFixture("src_utils.json", project.modulesDir);

    await buildDepGraph(project.projectRoot);

    const outputPath = join(project.dataDir, "dependency-data.json");
    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as DependencyData;

    expect(parsed.module_graph).toHaveProperty("src_auth");
    expect(parsed.module_graph).toHaveProperty("src_utils");
  });

  it("returns correct summary counts", async () => {
    project = await createTestProject();

    await copyFixture("src_cycle_a.json", project.modulesDir);
    await copyFixture("src_cycle_b.json", project.modulesDir);

    const { summary } = await buildDepGraph(project.projectRoot);

    expect(summary.modules).toBe(2);
    expect(summary.cycles).toBe(1);
    expect(summary.hubs).toBe(0);
  });

  it("classifies hub modules when fan_in exceeds threshold", async () => {
    project = await createTestProject();

    // Create a scenario where one module has very high fan-in.
    // We need fan_in > max(median * 2, 2), so fan_in > 2 at minimum.
    // With 4 modules all depending on "core", core gets fan_in=4.
    // Median fan-in across 5 modules: [0,0,0,0,4] → median=0 → threshold=max(0,2)=2
    // 4 > 2 → hub

    for (const name of ["mod_a", "mod_b", "mod_c", "mod_d"]) {
      await writeFile(
        join(project.modulesDir, `${name}.json`),
        JSON.stringify({
          directory: name,
          total_lines: 100,
          test_coverage: "none",
          documentation_quality: "missing",
          internal_dependencies: ["core"],
          external_dependencies: [],
          files: [],
        }),
      );
    }

    await writeFile(
      join(project.modulesDir, "core.json"),
      JSON.stringify({
        directory: "core",
        total_lines: 500,
        test_coverage: "full",
        documentation_quality: "comprehensive",
        internal_dependencies: [],
        external_dependencies: [],
        files: [],
      }),
    );

    const { data } = await buildDepGraph(project.projectRoot);

    expect(data.module_graph["core"].fan_in).toBe(4);
    expect(data.hub_modules).toContain("core");
  });

  it("skips malformed JSON files gracefully", async () => {
    project = await createTestProject();

    await copyFixture("src_auth.json", project.modulesDir);

    // Write an invalid JSON file
    await writeFile(
      join(project.modulesDir, "broken.json"),
      "{ this is not valid json",
    );

    const { data } = await buildDepGraph(project.projectRoot);

    // Should still process src_auth
    expect(data.module_graph).toHaveProperty("src_auth");
    // Broken file is skipped by readAllModules
    expect(data.module_graph).not.toHaveProperty("broken");
  });

  it("handles modules with missing internal_dependencies field", async () => {
    project = await createTestProject();

    await writeFile(
      join(project.modulesDir, "no_deps.json"),
      JSON.stringify({
        directory: "no_deps",
        total_lines: 50,
        test_coverage: "none",
        documentation_quality: "missing",
        files: [],
      }),
    );

    const { data } = await buildDepGraph(project.projectRoot);

    expect(data.module_graph["no_deps"].depends_on).toEqual([]);
    expect(data.module_graph["no_deps"].fan_out).toBe(0);
    expect(data.module_graph["no_deps"].external_deps).toEqual([]);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assembleDepGraphReport } from "../../../scripts/reports/dep-graph-report.js";
import {
  createTestProject,
  type TestProject,
} from "../../helpers.js";

let project: TestProject | null = null;

afterEach(async () => {
  if (project) {
    await project.cleanup();
    project = null;
  }
});

async function writeDependencyData(
  dataDir: string,
  data: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(dataDir, "dependency-data.json"),
    JSON.stringify(data),
  );
}

describe("assembleDepGraphReport", () => {
  it("handles missing dependency data gracefully", async () => {
    project = await createTestProject();

    await assembleDepGraphReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).toContain("# Dependency Graph");
    expect(report).toContain("No dependency data available");
  });

  it("shows module count and dependency summary", async () => {
    project = await createTestProject();
    await writeDependencyData(project.dataDir, {
      module_graph: {
        src_api: { depends_on: ["src_utils"], depended_on_by: [], fan_in: 0, fan_out: 1, external_deps: [] },
        src_utils: { depends_on: [], depended_on_by: ["src_api"], fan_in: 1, fan_out: 0, external_deps: [] },
      },
      circular_dependencies: [],
      hub_modules: [],
      orphan_modules: [],
      external_dependencies: {},
    });

    await assembleDepGraphReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).toContain("**2 modules**");
    expect(report).toContain("0 circular dependencies");
  });

  it("renders internal dependency arrows", async () => {
    project = await createTestProject();
    await writeDependencyData(project.dataDir, {
      module_graph: {
        src_api: { depends_on: ["src_utils", "src_auth"], depended_on_by: [], fan_in: 0, fan_out: 2, external_deps: [] },
        src_auth: { depends_on: ["src_utils"], depended_on_by: ["src_api"], fan_in: 1, fan_out: 1, external_deps: [] },
        src_utils: { depends_on: [], depended_on_by: ["src_api", "src_auth"], fan_in: 2, fan_out: 0, external_deps: [] },
      },
      circular_dependencies: [],
      hub_modules: ["src_utils"],
      orphan_modules: [],
      external_dependencies: { express: ["src_api", "src_auth"] },
    });

    await assembleDepGraphReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).toContain("src_api → src_utils, src_auth");
    expect(report).toContain("src_utils → (none)");
  });

  it("displays circular dependencies", async () => {
    project = await createTestProject();
    await writeDependencyData(project.dataDir, {
      module_graph: {
        a: { depends_on: ["b"], depended_on_by: ["b"], fan_in: 1, fan_out: 1, external_deps: [] },
        b: { depends_on: ["a"], depended_on_by: ["a"], fan_in: 1, fan_out: 1, external_deps: [] },
      },
      circular_dependencies: [["a", "b"]],
      hub_modules: [],
      orphan_modules: [],
      external_dependencies: {},
    });

    await assembleDepGraphReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).toContain("## Circular Dependencies");
    expect(report).toContain("a → b");
  });

  it("displays hub and orphan modules", async () => {
    project = await createTestProject();
    await writeDependencyData(project.dataDir, {
      module_graph: {
        hub: { depends_on: [], depended_on_by: ["a", "b", "c"], fan_in: 3, fan_out: 0, external_deps: [] },
        orphan: { depends_on: ["external"], depended_on_by: [], fan_in: 0, fan_out: 1, external_deps: [] },
      },
      circular_dependencies: [],
      hub_modules: ["hub"],
      orphan_modules: ["orphan"],
      external_dependencies: {},
    });

    await assembleDepGraphReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).toContain("## Hub Modules");
    expect(report).toContain("**hub**");
    expect(report).toContain("## Orphan Modules");
    expect(report).toContain("orphan");
  });

  it("includes external dependencies table", async () => {
    project = await createTestProject();
    await writeDependencyData(project.dataDir, {
      module_graph: {},
      circular_dependencies: [],
      hub_modules: [],
      orphan_modules: [],
      external_dependencies: {
        express: ["src_api", "src_auth"],
        lodash: ["src_utils"],
      },
    });

    await assembleDepGraphReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).toContain("## External Dependencies");
    expect(report).toContain("express");
    expect(report).toContain("lodash");
  });

  it("includes the interpretation placeholder", async () => {
    project = await createTestProject();
    await writeDependencyData(project.dataDir, {
      module_graph: {},
      circular_dependencies: [],
      hub_modules: [],
      orphan_modules: [],
      external_dependencies: {},
    });

    await assembleDepGraphReport(project.projectRoot);

    const report = await readFile(
      join(project.reportsDir, "DEPENDENCY_GRAPH.md"),
      "utf-8",
    );
    expect(report).toContain("<!-- DEP_GRAPH_INTERPRETATION_PLACEHOLDER -->");
  });
});

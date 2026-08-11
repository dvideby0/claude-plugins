import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db/db.js";
import {
  cancelScipEvaluation,
  detectProviders,
  latestScipEvaluation,
  runScipEvaluation,
  type ScipEvaluation,
} from "../providers/index.js";
import { scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { indexedSourceSignature } from "../scan/signature.js";

const roots: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider boundary", () => {
  it("reports bundled syntax and SCIP separately from optional Joern", async () => {
    const providers = await detectProviders(true);
    expect(providers.map((provider) => provider.id)).toEqual([
      "tree-sitter",
      "scip-typescript",
      "joern",
    ]);
    expect(providers[0]).toMatchObject({ available: true, bundled: true, trust: "syntax" });
    expect(providers[1]).toMatchObject({ bundled: true, version: "0.4.0", trust: "unverified" });
    expect(providers[1]?.detail).toMatch(/snapshot|support is unavailable/);
    expect(providers[2]).toMatchObject({ bundled: false, trust: "unverified" });
  });

  it("skips interrupted manifests when reading the latest evaluation", async () => {
    const state = await temporary("sdlc-provider-state-");
    const root = join(state, "abcdef123456", "scip-typescript");
    await mkdir(join(root, "2026-01-01"), { recursive: true });
    await mkdir(join(root, "2026-01-02"), { recursive: true });
    const fixture = {
      runId: "2026-01-01",
      provider: "scip-typescript",
      status: "failed",
    } as ScipEvaluation;
    await writeFile(join(root, "2026-01-01", "manifest.json"), JSON.stringify(fixture));
    await writeFile(join(root, "2026-01-02", "manifest.json"), "not json");

    await expect(
      latestScipEvaluation("abcdef123456", { artifactsRoot: state }),
    ).resolves.toMatchObject({
      runId: "2026-01-01",
    });
  });

  it("preserves failed diagnostics when their staged source generation is old", async () => {
    const state = await temporary("sdlc-provider-failed-state-");
    const root = join(state, "111122223333", "scip-typescript", "2026-01-01");
    await mkdir(root, { recursive: true });
    const fixture = {
      runId: "2026-01-01",
      provider: "scip-typescript",
      status: "failed",
      trust: "unverified",
      exact: false,
      reason: "provider_failed",
      input: { sourceSignature: "old-source" },
      scip: null,
      error: "SCIP could not parse the project config.",
    } as ScipEvaluation;
    await writeFile(join(root, "manifest.json"), JSON.stringify(fixture));

    await expect(
      latestScipEvaluation("111122223333", {
        artifactsRoot: state,
        currentSourceSignature: "new-source",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      trust: "unverified",
      reason: "provider_failed",
      error: "SCIP could not parse the project config.",
    });
  });

  const native = loadNative();
  const nativeIt =
    native?.inspectScip && native.stageSourceSnapshot && native.snapshotManifest ? it : it.skip;
  nativeIt("runs and decodes the bundled SCIP indexer without promoting its facts", async () => {
    const project = await temporary("sdlc-scip-project-");
    const artifacts = await temporary("sdlc-scip-artifacts-");
    const fixture = fileURLToPath(
      new URL("../../fixtures/eval/typescript-entry-effect/", import.meta.url),
    );
    await cp(fixture, project, { recursive: true });
    const oracle = JSON.parse(await readFile(join(project, "oracle.json"), "utf-8"));

    try {
      await scan(project, { full: true, kind: "provider-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("abcdef123456", project, db, artifacts);

      expect(evaluation).toMatchObject({ status: "partial", trust: "unverified", exact: false });
      expect(evaluation.error).toMatch(/dependency and out-of-tree compiler inputs/i);
      expect(evaluation.projects).toEqual(["."]);
      expect(evaluation.scip?.documents).toBe(oracle.scip.documents);
      expect(evaluation.scip?.definitions).toBeGreaterThanOrEqual(oracle.scip.minimumDefinitions);
      expect(evaluation.scip?.references).toBeGreaterThanOrEqual(oracle.scip.minimumReferences);
      expect(evaluation.indexPath).toContain(artifacts);
      expect(evaluation.input?.entries).toBeUndefined();
      const manifest = JSON.parse(
        await readFile(join(evaluation.artifactDir, "manifest.json"), "utf-8"),
      );
      expect(manifest.reason).toBe("immutable_staged_snapshot");
      expect(manifest.input.sourceSignature).toBe(indexedSourceSignature(db));
      expect(manifest.input.inputSignature).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.input.entries.some((entry: { path: string }) => entry.path === "src/main.ts"))
        .toBe(true);
      await expect(readdir(join(evaluation.artifactDir, "input"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("does not promote output influenced by an out-of-tree project input", async () => {
    const project = await temporary("sdlc-scip-outside-project-");
    const outside = await temporary("sdlc-scip-outside-input-");
    const artifacts = await temporary("sdlc-scip-outside-artifacts-");
    const outsideSource = join(outside, "external.ts");
    await writeFile(outsideSource, "export const outside = 1;\n");
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "outside-input" }));
    await writeFile(join(project, "tsconfig.json"), JSON.stringify({ files: [outsideSource] }));

    try {
      await scan(project, { full: true, kind: "provider-outside-input-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("111122223333", project, db, artifacts);

      expect(evaluation).toMatchObject({ status: "partial", trust: "unverified", exact: false });
      expect(evaluation.scip?.documents).toBe(1);
      expect(evaluation.error).toMatch(/out-of-tree compiler inputs/i);
      expect(evaluation.input?.entries).toBeUndefined();
      const manifest = JSON.parse(
        await readFile(join(evaluation.artifactDir, "manifest.json"), "utf-8"),
      );
      expect(
        manifest.input.entries.some((entry: { path: string }) =>
          entry.path.includes("external.ts"),
        ),
      ).toBe(false);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("does not promote a source-only snapshot that omits installed dependencies", async () => {
    const project = await temporary("sdlc-scip-dependency-project-");
    const artifacts = await temporary("sdlc-scip-dependency-artifacts-");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "node_modules", "fixture-dep"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "dependency-input", dependencies: { "fixture-dep": "1.0.0" } }),
    );
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        files: ["src/main.ts"],
      }),
    );
    await writeFile(
      join(project, "src", "main.ts"),
      'import { external } from "fixture-dep"; export const answer = external();\n',
    );
    await writeFile(
      join(project, "node_modules", "fixture-dep", "package.json"),
      JSON.stringify({ name: "fixture-dep", version: "1.0.0", types: "index.d.ts" }),
    );
    await writeFile(
      join(project, "node_modules", "fixture-dep", "index.d.ts"),
      "export declare function external(): number;\n",
    );

    try {
      await scan(project, { full: true, kind: "provider-dependency-input-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("444455556666", project, db, artifacts);

      expect(evaluation).toMatchObject({ status: "partial", trust: "unverified", exact: false });
      expect(evaluation.error).toMatch(/dependency and out-of-tree compiler inputs/i);
      expect(evaluation.input?.entries).toBeUndefined();
      const manifest = JSON.parse(
        await readFile(join(evaluation.artifactDir, "manifest.json"), "utf-8"),
      );
      expect(
        manifest.input.entries.some((entry: { path: string }) =>
          entry.path.startsWith("node_modules/"),
        ),
      ).toBe(false);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("discovers nested TypeScript projects when the repository root has no config", async () => {
    const project = await temporary("sdlc-scip-monorepo-");
    const artifacts = await temporary("sdlc-scip-monorepo-artifacts-");
    for (const child of ["apps/web", "packages/api"]) {
      await mkdir(join(project, child, "src"), { recursive: true });
      await writeFile(
        join(project, child, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
          include: ["src/**/*.ts"],
        }),
      );
      await writeFile(
        join(project, child, "src", "index.ts"),
        `export const ${child.startsWith("apps") ? "webValue" : "apiValue"} = 1;\n`,
      );
    }

    try {
      await scan(project, { full: true, kind: "provider-monorepo-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("123456abcdef", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["apps/web", "packages/api"]);
      expect(evaluation.scip?.documents).toBe(2);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("lets SCIP follow custom-named configs from a solution-style root", async () => {
    const project = await temporary("sdlc-scip-solution-");
    const artifacts = await temporary("sdlc-scip-solution-artifacts-");
    await mkdir(join(project, "src"));
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
    );
    await writeFile(
      join(project, "tsconfig.app.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        files: ["src/app.ts"],
      }),
    );
    await writeFile(join(project, "src", "app.ts"), "export const app = 1;\n");

    try {
      await scan(project, { full: true, kind: "provider-solution-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("eeeeffffaaaa", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["."]);
      expect(evaluation.scip?.documents).toBe(1);
      expect(evaluation.scip?.sampleDocuments[0]?.path).toMatch(/src\/app\.ts$/);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("uses an app-owned inferred config without modifying a configless workspace", async () => {
    const project = await temporary("sdlc-scip-javascript-");
    const artifacts = await temporary("sdlc-scip-javascript-artifacts-");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "plain-js", private: true }));
    await writeFile(join(project, "src", "index.js"), "export const answer = 42;\n");

    try {
      await scan(project, { full: true, kind: "provider-javascript-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("abcdef654321", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["(app-owned inferred config)"]);
      expect(evaluation.scip?.documents).toBe(1);
      await expect(readFile(join(project, "tsconfig.json"), "utf-8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const manifest = JSON.parse(
        await readFile(join(evaluation.artifactDir, "manifest.json"), "utf-8"),
      );
      expect(
        manifest.input.entries.some(
          (entry: { path: string }) =>
            entry.path === ".sdlc-provider/inferred-tsconfig.json",
        ),
      ).toBe(true);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("honors jsconfig project selection instead of broadening it with inference", async () => {
    const project = await temporary("sdlc-scip-jsconfig-");
    const artifacts = await temporary("sdlc-scip-jsconfig-artifacts-");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { allowJs: true }, files: ["src/included.js"] }),
    );
    await writeFile(join(project, "src", "included.js"), "export const included = 1;\n");
    await writeFile(join(project, "src", "excluded.js"), "export const excluded = 2;\n");

    try {
      await scan(project, { full: true, kind: "provider-jsconfig-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("aaaabbbbcccc", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["jsconfig.json"]);
      expect(evaluation.scip?.documents).toBe(1);
      const indexed = evaluation.scip?.sampleDocuments.map((document) => document.path) ?? [];
      expect(indexed).toHaveLength(1);
      expect(indexed[0]).toMatch(/src\/included\.js$/);
      expect(indexed.some((path) => path.endsWith("src/excluded.js"))).toBe(false);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("treats project paths as argv data and never as upstream flags", async () => {
    const project = await temporary("sdlc-scip-argv-");
    const artifacts = await temporary("sdlc-scip-argv-artifacts-");
    const child = join(project, "--infer-tsconfig");
    await mkdir(child);
    await writeFile(join(child, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    await writeFile(join(child, "index.ts"), "export const value = 1;\n");

    try {
      await scan(project, { full: true, kind: "provider-argv-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("bbbbaaaacccc", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["--infer-tsconfig"]);
      await expect(readFile(join(project, "tsconfig.json"), "utf-8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("summarizes overlapping TypeScript projects without double-counting documents", async () => {
    const project = await temporary("sdlc-scip-overlap-");
    const artifacts = await temporary("sdlc-scip-overlap-artifacts-");
    await mkdir(join(project, "packages", "api", "src"), { recursive: true });
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["packages/**/*.ts"],
      }),
    );
    await writeFile(
      join(project, "packages", "api", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(join(project, "packages", "api", "src", "index.ts"), "export const api = 1;\n");

    try {
      await scan(project, { full: true, kind: "provider-overlap-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("fedcba123456", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual([".", "packages/api"]);
      expect(evaluation.scip?.documents).toBe(1);
      expect(evaluation.scip?.sampleDocuments).toHaveLength(1);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("reports a successful but incomplete multi-project index as partial", async () => {
    const project = await temporary("sdlc-scip-partial-");
    const artifacts = await temporary("sdlc-scip-partial-artifacts-");
    for (const [child, target] of [
      ["good", "ES2022"],
      ["bad", "NOT_A_TARGET"],
    ]) {
      await mkdir(join(project, child, "src"), { recursive: true });
      await writeFile(
        join(project, child, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target, module: "NodeNext", moduleResolution: "NodeNext" },
          include: ["src/**/*.ts"],
        }),
      );
      await writeFile(join(project, child, "src", "index.ts"), "export const value = 1;\n");
    }

    try {
      await scan(project, { full: true, kind: "provider-partial-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("012345abcdef", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["bad", "good"]);
      expect(evaluation.scip?.documents).toBe(1);
      expect(evaluation.indexPath).not.toBeNull();
      expect(evaluation.error).toMatch(/TS6046/);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("reports an upstream file-size skip as partial", async () => {
    const project = await temporary("sdlc-scip-large-file-");
    const artifacts = await temporary("sdlc-scip-large-file-artifacts-");
    for (const child of ["good", "large"]) {
      await mkdir(join(project, child), { recursive: true });
      await writeFile(join(project, child, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    }
    await writeFile(join(project, "good", "index.ts"), "export const good = 1;\n");
    await writeFile(
      join(project, "large", "index.ts"),
      `export const large = "${"x".repeat(1024 * 1024 + 64)}";\n`,
    );

    try {
      await scan(project, { full: true, kind: "provider-large-file-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("ccccbbbbaaaa", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["good", "large"]);
      expect(evaluation.scip?.documents).toBe(1);
      expect(evaluation.error).toMatch(/skipping file/i);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("reports an invalid requested config alongside usable project output", async () => {
    const project = await temporary("sdlc-scip-invalid-config-");
    const artifacts = await temporary("sdlc-scip-invalid-config-artifacts-");
    for (const child of ["bad", "good"]) await mkdir(join(project, child), { recursive: true });
    await writeFile(join(project, "bad", "tsconfig.json"), "{ invalid json");
    await writeFile(join(project, "bad", "index.ts"), "export const bad = 1;\n");
    await writeFile(join(project, "good", "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    await writeFile(join(project, "good", "index.ts"), "export const good = 1;\n");

    try {
      await scan(project, { full: true, kind: "provider-invalid-config-test" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation("ddddaaaabbbb", project, db, artifacts);

      expect(evaluation.status).toBe("partial");
      expect(evaluation.projects).toEqual(["bad", "good"]);
      expect(evaluation.scip?.documents).toBe(1);
      expect(evaluation.error).toMatch(/bad\/tsconfig\.json/);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("cancels promptly outside the provider subprocess phase", async () => {
    const project = await temporary("sdlc-scip-cancel-");
    const artifacts = await temporary("sdlc-scip-cancel-artifacts-");
    await writeFile(join(project, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    await writeFile(join(project, "index.ts"), "export const value = 1;\n");
    const workspaceId = "012345fedcba";

    try {
      await scan(project, { full: true, kind: "provider-cancel-test" });
      const db = await getDb(project);
      const running = runScipEvaluation(workspaceId, project, db, artifacts);
      const cancelling = cancelScipEvaluation(workspaceId);

      await expect(running).rejects.toThrow(/cancelled/i);
      await cancelling;
      await expect(
        readdir(join(artifacts, workspaceId, "scip-typescript")),
      ).resolves.toEqual([]);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("cancels promptly while native snapshot manifesting is still settling", async () => {
    const project = await temporary("sdlc-scip-manifest-cancel-");
    const artifacts = await temporary("sdlc-scip-manifest-cancel-artifacts-");
    await writeFile(join(project, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    await writeFile(join(project, "index.ts"), "export const value = 1;\n");
    const workspaceId = "123456abcdef";
    const runtime = loadNative()!;
    const originalManifest = runtime.snapshotManifest!;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });

    try {
      await scan(project, { full: true, kind: "provider-manifest-cancel-test" });
      const db = await getDb(project);
      runtime.snapshotManifest = async (path) => {
        enteredResolve();
        await release;
        return originalManifest(path);
      };

      const running = runScipEvaluation(workspaceId, project, db, artifacts);
      const rejected = running.then(
        () => null,
        (error: unknown) => error,
      );
      await entered;
      const cancelling = cancelScipEvaluation(workspaceId);
      const settledPromptly = await Promise.race([
        cancelling.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);

      expect(settledPromptly).toBe(true);
      expect(String(await rejected)).toMatch(/cancelled/i);

      releaseResolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(
        readdir(join(artifacts, workspaceId, "scip-typescript")),
      ).resolves.toEqual([]);
    } finally {
      runtime.snapshotManifest = originalManifest;
      releaseResolve();
      await closeDb(project);
    }
  });

  nativeIt("marks an unverified provider result stale after the indexed source changes", async () => {
    const project = await temporary("sdlc-scip-stale-");
    const artifacts = await temporary("sdlc-scip-stale-artifacts-");
    await writeFile(join(project, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    await writeFile(join(project, "index.ts"), "export const value = 1;\n");
    const workspaceId = "aaaaffff1111";

    try {
      await scan(project, { full: true, kind: "provider-stale-initial" });
      const db = await getDb(project);
      const evaluation = await runScipEvaluation(workspaceId, project, db, artifacts);
      expect(evaluation).toMatchObject({ trust: "unverified", exact: false });

      await writeFile(join(project, "index.ts"), "export const value = 2;\n");
      await scan(project, { kind: "provider-stale-refresh" });
      await expect(
        latestScipEvaluation(workspaceId, {
          artifactsRoot: artifacts,
          currentSourceSignature: indexedSourceSignature(db),
        }),
      ).resolves.toMatchObject({
        trust: "stale",
        exact: false,
        reason: "working_tree_changed",
      });
    } finally {
      await closeDb(project);
    }
  });
});

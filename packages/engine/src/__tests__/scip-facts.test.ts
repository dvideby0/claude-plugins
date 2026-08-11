import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db/db.js";
import { projectScipFacts } from "../facts/scip.js";
import { runScipEvaluation, type ScipEvaluation } from "../providers/index.js";
import { scan } from "../scan/scan.js";
import { loadNative } from "../scan/source.js";
import { indexedSourceSignature } from "../scan/signature.js";

const roots: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function inputSignature(entries: Array<{ path: string; sha256: string }>): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function pathAliasSignature(aliases: Array<{ providerPath: string; path: string }>): string {
  const hash = createHash("sha256");
  const length = (value: string): Buffer => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(Buffer.byteLength(value)));
    return bytes;
  };
  for (const alias of [...aliases].sort((left, right) =>
    left.providerPath.localeCompare(right.providerPath)
  )) {
    hash.update(length(alias.providerPath));
    hash.update(alias.providerPath);
    hash.update(length(alias.path));
    hash.update(alias.path);
  }
  return hash.digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SCIP fact projection", () => {
  const native = loadNative();
  const nativeIt =
    native?.inspectScip &&
    native.projectScip &&
    native.stageSourceSnapshot &&
    native.snapshotManifest &&
    native.verifySnapshotManifest
      ? it
      : it.skip;

  nativeIt("projects official occurrences into the evidence envelope without promoting trust", async () => {
    const project = await temporary("sdlc-scip-facts-project-");
    const artifacts = await temporary("sdlc-scip-facts-artifacts-");
    const fixture = fileURLToPath(
      new URL("../../fixtures/eval/typescript-entry-effect/", import.meta.url),
    );
    await cp(fixture, project, { recursive: true });

    try {
      await scan(project, { full: true, kind: "scip-fact-projection-test" });
      const db = await getDb(project);
      const sourceSignature = indexedSourceSignature(db);
      const evaluation = await runScipEvaluation("facefeed1234", project, db, artifacts);
      const facts = await projectScipFacts(evaluation, {
        workspaceId: "facefeed1234",
        currentSourceSignature: sourceSignature,
      });

      expect(facts.generation).toEqual({
        sourceSignature,
        inputSignature: evaluation.input?.inputSignature,
        runId: evaluation.runId,
      });
      expect(facts.generatedAt).toBe(evaluation.finishedAt);
      expect(facts.nodes.filter((node) => node.kind === "file").map((node) => node.name)).toEqual(
        expect.arrayContaining(["src/main.ts", "src/store.ts"]),
      );
      expect(facts.nodes.some((node) => node.kind === "symbol" && node.anchor?.range)).toBe(true);
      expect(
        facts.edges.some(
          (edge) => edge.kind !== "contain" && edge.target.path === "src/store.ts",
        ),
      ).toBe(true);
      expect(
        facts.edges.some(
          (edge) => edge.evidence[0]?.anchor?.range?.startLine === 0,
        ),
      ).toBe(true);
      expect([
        ...new Set(
          facts.edges
            .flatMap((edge) => edge.evidence)
            .filter((evidence) => evidence.anchor?.range)
            .map((evidence) => evidence.anchor?.positionEncoding),
        ),
      ]).toEqual(["unknown"]);
      expect([...facts.nodes, ...facts.edges]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            producer: {
              id: "scip-typescript",
              version: evaluation.providerVersion,
              kind: "compiler",
            },
            freshness: "unverified",
            ownership: { scope: "provider-run", key: evaluation.runId },
          }),
        ]),
      );
      expect([...facts.nodes, ...facts.edges].every((fact) => fact.freshness === "unverified"))
        .toBe(true);
      expect(
        facts.edges.every((edge) =>
          edge.evidence.every((item) => item.anchor || item.unavailableReason),
        ),
      ).toBe(true);

      const stale = await projectScipFacts(evaluation, {
        workspaceId: "facefeed1234",
        currentSourceSignature: "different-source-generation",
      });
      expect([...stale.nodes, ...stale.edges].every((fact) => fact.freshness === "stale"))
        .toBe(true);

      const callerPromoted = await projectScipFacts(
        { ...evaluation, exact: true, trust: "exact" },
        { workspaceId: "facefeed1234", currentSourceSignature: sourceSignature },
      );
      expect([...callerPromoted.nodes, ...callerPromoted.edges].every(
        (fact) => fact.freshness === "unverified",
      )).toBe(true);
      await expect(
        projectScipFacts(evaluation, {
          workspaceId: "different-workspace",
          currentSourceSignature: sourceSignature,
        }),
      ).rejects.toThrow(/does not belong to this workspace/i);
      await expect(
        projectScipFacts(
          { ...evaluation, providerVersion: "forged-version" },
          { workspaceId: "facefeed1234", currentSourceSignature: sourceSignature },
        ),
      ).rejects.toThrow(/durable run manifest/i);
      await expect(
        projectScipFacts(evaluation, { workspaceId: "facefeed1234" } as never),
      ).rejects.toThrow(/current indexed source generation/i);

      await expect(
        projectScipFacts(
          {
            ...evaluation,
            scip: evaluation.scip ? { ...evaluation.scip, sha256: "0".repeat(64) } : null,
          },
          { workspaceId: "facefeed1234", currentSourceSignature: sourceSignature },
        ),
      ).rejects.toThrow(/output digest/i);

      const manifestPath = join(evaluation.artifactDir, "manifest.json");
      const originalManifest = await readFile(manifestPath, "utf-8");
      const inconsistent = JSON.parse(originalManifest);
      inconsistent.input.entries[0].sha256 = "0".repeat(64);
      await writeFile(manifestPath, JSON.stringify(inconsistent));
      await expect(
        projectScipFacts(evaluation, {
          workspaceId: "facefeed1234",
          currentSourceSignature: sourceSignature,
        }),
      ).rejects.toThrow(/manifest signature does not match/i);

      const manifest = JSON.parse(originalManifest);
      manifest.input.entries = manifest.input.entries.filter(
        (entry: { path: string }) => entry.path !== "src/main.ts",
      );
      manifest.input.files = manifest.input.entries.length;
      manifest.input.bytes = manifest.input.entries.reduce(
        (total: number, entry: { bytes: number }) => total + entry.bytes,
        0,
      );
      manifest.input.inputSignature = inputSignature(manifest.input.entries);
      await writeFile(manifestPath, JSON.stringify(manifest));
      const missingInputEvaluation = {
        ...evaluation,
        input: evaluation.input
          ? {
              ...evaluation.input,
              inputSignature: manifest.input.inputSignature,
              files: manifest.input.files,
              bytes: manifest.input.bytes,
            }
          : null,
      };
      await expect(
        projectScipFacts(missingInputEvaluation, {
          workspaceId: "facefeed1234",
          currentSourceSignature: sourceSignature,
        }),
      ).rejects.toThrow(/attested provider input manifest/i);
    } finally {
      await closeDb(project);
    }
  });

  nativeIt("keeps repeated relationships path-specific with matching evidence", async () => {
    const artifactDir = await temporary("sdlc-scip-relationship-facts-");
    const inputRoot = join(artifactDir, "input");
    const indexPath = join(artifactDir, "index.scip");
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("@sourcegraph/scip-typescript/package.json");
    const { scip } = require(join(dirname(packagePath), "dist/src/scip.js"));
    const source = "scip-typescript npm fixture 1.0.0 Source#";
    const target = "scip-typescript npm fixture 1.0.0 Target#";
    const document = (path: string): unknown => new scip.Document({
      relative_path: path,
      language: "typescript",
      occurrences: [
        new scip.Occurrence({
          range: [0, 0, 6],
          symbol: source,
          symbol_roles: scip.SymbolRole.Definition,
        }),
      ],
      symbols: [
        new scip.SymbolInformation({
          symbol: source,
          display_name: "Source",
          relationships: [
            new scip.Relationship({ symbol: target, is_implementation: true }),
          ],
        }),
      ],
    });
    const index = new scip.Index({
      metadata: new scip.Metadata({ project_root: `file://${inputRoot}` }),
      documents: [document("a.ts"), document("b.ts")],
    });
    await writeFile(indexPath, index.serializeBinary());
    const summary = await native!.inspectScip!(indexPath);
    const emptySha = createHash("sha256").update("").digest("hex");
    const entries = ["a.ts", "b.ts"].map((path) => ({ path, bytes: 0, sha256: emptySha }));
    const evaluation: ScipEvaluation = {
      workspaceId: "relationship-workspace",
      runId: "relationship-run",
      provider: "scip-typescript",
      providerVersion: "0.4.0",
      status: "partial",
      trust: "unverified",
      exact: false,
      reason: "immutable_staged_snapshot",
      startedAt: "2026-08-10T00:00:00.000Z",
      finishedAt: "2026-08-10T00:00:01.000Z",
      durationMs: 1_000,
      artifactDir,
      indexPath,
      projects: ["."],
      baseline: { documents: 2, symbols: 0, references: 0 },
      input: {
        sourceSignature: "relationship-source",
        inputSignature: inputSignature(entries),
        files: entries.length,
        bytes: 0,
        entries,
        pathAliases: [],
        pathAliasSignature: pathAliasSignature([]),
      },
      scip: summary,
      error: "Compiler dependency closure is not attested.",
    };
    await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(evaluation));

    const facts = await projectScipFacts(evaluation, {
      workspaceId: evaluation.workspaceId,
      currentSourceSignature: evaluation.input!.sourceSignature,
    });
    const relationships = facts.edges.filter(
      (edge) => edge.nativeKind === "scip-relationship:implementation",
    );
    expect(relationships).toHaveLength(2);
    expect(new Set(relationships.map((edge) => edge.id)).size).toBe(2);
    expect(relationships.map((edge) => edge.evidence[0]?.anchor?.path).sort()).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  nativeIt("retains manifest casing for provider path aliases after deleting the snapshot", async () => {
    const artifactDir = await temporary("sdlc-scip-case-alias-facts-");
    const inputRoot = join(artifactDir, "input");
    const indexPath = join(artifactDir, "index.scip");
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("@sourcegraph/scip-typescript/package.json");
    const { scip } = require(join(dirname(packagePath), "dist/src/scip.js"));
    const symbol = "scip-typescript npm fixture 1.0.0 Main#";
    const index = new scip.Index({
      metadata: new scip.Metadata({ project_root: `file://${inputRoot}` }),
      documents: [
        new scip.Document({
          relative_path: "src/main.ts",
          language: "typescript",
          occurrences: [
            new scip.Occurrence({
              range: [0, 0, 4],
              symbol,
              symbol_roles: scip.SymbolRole.Definition,
            }),
          ],
          symbols: [new scip.SymbolInformation({ symbol, display_name: "Main" })],
        }),
      ],
    });
    await writeFile(indexPath, index.serializeBinary());
    const summary = await native!.inspectScip!(indexPath);
    const emptySha = createHash("sha256").update("").digest("hex");
    const entries = ["Other.ts", "Src/Main.ts"].map((path) => ({
      path,
      bytes: 0,
      sha256: emptySha,
    }));
    const pathAliases = [{ providerPath: "src/main.ts", path: "Src/Main.ts" }];
    const evaluation: ScipEvaluation = {
      workspaceId: "case-alias-workspace",
      runId: "case-alias-run",
      provider: "scip-typescript",
      providerVersion: "0.4.0",
      status: "partial",
      trust: "unverified",
      exact: false,
      reason: "immutable_staged_snapshot",
      startedAt: "2026-08-10T00:00:00.000Z",
      finishedAt: "2026-08-10T00:00:01.000Z",
      durationMs: 1_000,
      artifactDir,
      indexPath,
      projects: ["."],
      baseline: { documents: 1, symbols: 0, references: 0 },
      input: {
        sourceSignature: "case-alias-source",
        inputSignature: inputSignature(entries),
        files: entries.length,
        bytes: 0,
        entries,
        pathAliases,
        pathAliasSignature: pathAliasSignature(pathAliases),
      },
      scip: summary,
      error: "Compiler dependency closure is not attested.",
    };
    const manifestPath = join(artifactDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(evaluation));

    const facts = await projectScipFacts(evaluation, {
      workspaceId: evaluation.workspaceId,
      currentSourceSignature: evaluation.input!.sourceSignature,
    });
    expect(facts.nodes.find((node) => node.kind === "file")?.name).toBe("Src/Main.ts");
    expect(facts.edges[0]?.evidence[0]?.anchor?.path).toBe("Src/Main.ts");
    expect(facts.nodes.map((node) => node.anchor?.path).filter(Boolean)).not.toContain(
      "src/main.ts",
    );
    expect(
      facts.edges.flatMap((edge) => edge.evidence.map((item) => item.anchor?.path)).filter(Boolean),
    ).not.toContain("src/main.ts");

    const forgedAlias = structuredClone(evaluation);
    forgedAlias.input!.pathAliases![0]!.path = "Other.ts";
    await writeFile(manifestPath, JSON.stringify(forgedAlias));
    await expect(
      projectScipFacts(evaluation, {
        workspaceId: evaluation.workspaceId,
        currentSourceSignature: evaluation.input!.sourceSignature,
      }),
    ).rejects.toThrow(/path alias signature/i);
  });
});

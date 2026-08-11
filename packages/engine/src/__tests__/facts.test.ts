import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/db.js";
import { projectLegacyFacts } from "../facts/legacy.js";
import { FACT_SCHEMA_VERSION, hasNavigableEvidence } from "../facts/model.js";
import { relate } from "../graph/relations.js";
import { resolveTypes, typedSpecifier } from "../graph/typed.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("provider-neutral fact contract", () => {
  it("projects legacy facts without conflating parsed, compiler, and asserted knowledge", async () => {
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts", "src/store.ts"] }),
      "src/main.ts": `import { save } from "./store";\nexport function run() { return save(); }\n`,
      "src/store.ts": `export function save() { return true; }\n`,
    });
    await scan(root, { full: true, kind: "fact-contract-test" });
    const db = await getDb(root);

    const run = db.get<{ id: string }>(
      "SELECT id FROM symbols WHERE path = 'src/main.ts' AND name = 'run'",
    );
    const save = db.get<{ id: string }>(
      "SELECT id FROM symbols WHERE path = 'src/store.ts' AND name = 'save'",
    );
    expect(run && save).toBeTruthy();
    db.run(
      `INSERT OR REPLACE INTO refs(
         src_path, src_line, src_column, src_end_column, name, specifier, dst_path,
         src_symbol, src_symbol_id, dst_line, dst_column, dst_symbol_id
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "src/main.ts",
        2,
        31,
        35,
        "save",
        typedSpecifier("src/store.ts", 1, 0),
        "src/store.ts",
        "run",
        run!.id,
        1,
        0,
        save!.id,
      ],
    );
    db.run(
      "INSERT OR REPLACE INTO edges(src_path, specifier, dst_path, external) VALUES(?, ?, NULL, NULL)",
      ["src/main.ts", "./missing"],
    );
    relate(db, {
      kind: "registers",
      srcPath: "src/main.ts",
      srcSymbol: "run",
      dstPath: "src/store.ts",
      dstSymbol: "save",
      evidence: "run registers save with the fixture framework",
      evidenceLine: 2,
      confidence: "high",
    });

    const facts = projectLegacyFacts(db, {
      workspaceId: "workspace-1",
      generatedAt: "2026-08-10T12:00:00.000Z",
    });

    expect(facts.schemaVersion).toBe(FACT_SCHEMA_VERSION);
    expect(facts.nodes.some((node) => node.kind === "file" && node.name === "src/main.ts")).toBe(
      true,
    );
    expect(
      facts.edges.find(
        (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
      ),
    ).toMatchObject({
      certainty: "exact",
      freshness: "unverified",
      evidence: [{ anchor: { path: "src/main.ts", positionEncoding: "utf-8" } }],
    });
    expect(
      facts.edges.find(
        (edge) => edge.kind === "import" && edge.target.nativeId === "./missing",
      ),
    ).toMatchObject({
      certainty: "unknown",
      target: { unresolvedReason: expect.any(String) },
    });
    expect(facts.edges.find((edge) => edge.kind === "register")).toMatchObject({
      certainty: "asserted",
      freshness: "unverified",
      generation: { sourceSignature: null, runId: expect.any(String) },
      confidence: "high",
      producer: { kind: "llm" },
      evidence: [{ detail: expect.stringContaining("registers save") }],
    });
    expect(facts.edges.every((edge) => edge.evidence.every(hasNavigableEvidence))).toBe(true);
  });

  it("keeps compiler declaration identity for locals that are not syntax-indexed symbols", async () => {
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts"] }),
      "src/main.ts":
        "export function run(input: number) { const local = input + 1; return local; }\n",
    });
    await scan(root, { full: true, kind: "fact-contract-local-test" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).resolved).toBe(2);

    const facts = projectLegacyFacts(db, {
      workspaceId: "workspace-1",
      generatedAt: "2026-08-10T12:00:00.000Z",
    });
    const references = facts.edges.filter(
      (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
    );

    expect(references).toHaveLength(2);
    expect(new Set(references.map((edge) => edge.target.id)).size).toBe(2);
    for (const reference of references) {
      expect(reference.target).toMatchObject({
        id: expect.stringMatching(/^symbol:/),
        nativeId: expect.stringMatching(/^typescript:src\/main\.ts:/),
        path: "src/main.ts",
      });
      expect(facts.nodes.some((node) => node.id === reference.target.id)).toBe(true);
      expect(reference.target.id).not.toBe(
        facts.nodes.find((node) => node.kind === "file" && node.name === "src/main.ts")?.id,
      );
    }
  });

  it("uses the declaration name for compiler-resolved default imports", async () => {
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts", "src/store.ts"] }),
      "src/main.ts":
        'import renamed from "./store";\nexport function run() { return renamed(); }\n',
      "src/store.ts": "export default function actualName() { return true; }\n",
    });
    await scan(root, { full: true, kind: "fact-contract-default-name-test" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).resolved).toBe(1);

    const reference = projectLegacyFacts(db, { workspaceId: "workspace-1" }).edges.find(
      (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
    );

    expect(reference?.target).toMatchObject({
      id: expect.stringMatching(/^symbol:/),
      nativeId: expect.stringContaining("actualName"),
      path: "src/store.ts",
      symbol: "actualName",
    });
  });

  it("preserves UTF-8 evidence ranges for aliased compiler references", async () => {
    const prefix = "/*😀*/ export function run() { return x(); }";
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts", "src/store.ts"] }),
      "src/main.ts": `import { veryLongName as x } from "./store";\n${prefix}\n`,
      "src/store.ts": "export function veryLongName() { return true; }\n",
    });
    await scan(root, { full: true, kind: "fact-contract-alias-range-test" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).resolved).toBe(1);

    const reference = projectLegacyFacts(db, { workspaceId: "workspace-1" }).edges.find(
      (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
    );
    const startColumn = Buffer.byteLength(prefix.slice(0, prefix.indexOf("x()")), "utf-8");
    expect(reference?.evidence[0]?.anchor).toMatchObject({
      path: "src/main.ts",
      positionEncoding: "utf-8",
      range: {
        startLine: 1,
        startColumn,
        endLine: 1,
        endColumn: startColumn + 1,
      },
    });
    expect(reference?.target.symbol).toBe("veryLongName");
  });

  it("marks compiler facts stale when the indexed workspace changes after resolution", async () => {
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts", "src/store.ts"] }),
      "src/main.ts":
        'import { save } from "./store";\nexport function run() { return save(); }\n',
      "src/store.ts": "export function save() { return true; }\n",
    });
    await scan(root, { full: true, kind: "fact-contract-freshness-test" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).resolved).toBe(1);
    const before = projectLegacyFacts(db, { workspaceId: "workspace-1" });
    const current = before.edges.find(
      (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
    );
    expect(current?.freshness).toBe("unverified");
    expect(current?.generation.sourceSignature).toBe(before.generation.sourceSignature);

    await writeFile(join(root, "src/store.ts"), "export function renamed() { return true; }\n");
    await scan(root, { kind: "fact-contract-freshness-test" });

    const after = projectLegacyFacts(db, { workspaceId: "workspace-1" });
    const stale = after.edges.find(
      (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
    );
    expect(stale?.freshness).toBe("stale");
    expect(stale?.generation).toEqual(current?.generation);
    expect(stale?.generation.sourceSignature).not.toBe(after.generation.sourceSignature);
  });

  it("does not bless compiler facts from files omitted by a later partial pass", async () => {
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts", "src/store.ts"] }),
      "src/main.ts":
        'import { save } from "./store";\nexport function run() { return save(); }\n',
      "src/store.ts": "export function save() { return true; }\n",
      "src/other.ts": "export const value = 1;\nconsole.log(value);\n",
    });
    await scan(root, { full: true, kind: "fact-contract-partial-generation-test" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).resolved).toBe(1);

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ files: ["src/other.ts"] }),
    );
    await scan(root, { kind: "fact-contract-partial-generation-test" });
    expect(resolveTypes(db, root).resolved).toBe(1);

    const references = projectLegacyFacts(db, { workspaceId: "workspace-1" }).edges.filter(
      (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
    );
    expect(references.find((edge) => edge.source.path === "src/main.ts")?.freshness).toBe("stale");
    expect(references.find((edge) => edge.source.path === "src/other.ts")?.freshness).toBe(
      "unverified",
    );
  });

  it("projects the complete compiler declaration token for escaped identifiers", async () => {
    const source = "export function run(\\u0061: number) { return a; }\n";
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts"] }),
      "src/main.ts": source,
    });
    await scan(root, { full: true, kind: "fact-contract-escaped-declaration-test" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).resolved).toBe(1);

    const declaration = projectLegacyFacts(db, { workspaceId: "workspace-1" }).nodes.find(
      (node) => node.producer.kind === "compiler" && node.name === "a",
    );
    const startColumn = Buffer.byteLength(source.slice(0, source.indexOf("\\u0061")), "utf-8");
    expect(declaration?.anchor).toMatchObject({
      positionEncoding: "utf-8",
      range: {
        startLine: 0,
        startColumn,
        endLine: 0,
        endColumn: startColumn + Buffer.byteLength("\\u0061", "utf-8"),
      },
    });
  });

  it("makes shared synthetic declaration freshness independent of reference order", async () => {
    root = await makeProject({
      "tsconfig.json": JSON.stringify({
        files: ["src/types.ts", "src/a.ts", "src/z.ts"],
      }),
      "src/types.ts": "export interface T { \\u0076alue: number }\n",
      "src/a.ts":
        'import type { T } from "./types"; export const a = (input: T) => input.value;\n',
      "src/z.ts":
        'import type { T } from "./types"; export const z = (input: T) => input.value;\n',
    });
    await scan(root, { full: true, kind: "fact-contract-shared-declaration-test" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).ran).toBe(true);

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ files: ["src/types.ts", "src/z.ts"] }),
    );
    await writeFile(join(root, "src/types.ts"), "export interface T { value: number }\n");
    await scan(root, { kind: "fact-contract-shared-declaration-test" });
    expect(resolveTypes(db, root).ran).toBe(true);

    const facts = projectLegacyFacts(db, { workspaceId: "workspace-1" });
    const references = facts.edges.filter(
      (edge) => edge.producer.kind === "compiler" && edge.target.symbol === "value",
    );
    const stale = references.find((edge) => edge.source.path === "src/a.ts");
    const current = references.find((edge) => edge.source.path === "src/z.ts");
    expect(stale?.freshness).toBe("stale");
    expect(current?.freshness).toBe("unverified");
    expect(stale?.target.id).toBe(current?.target.id);

    const declaration = facts.nodes.find((node) => node.id === current?.target.id);
    expect(declaration?.freshness).toBe("unverified");
    expect(declaration?.generation).toEqual(current?.generation);
    expect(declaration?.anchor?.range).toEqual({
      startLine: 0,
      startColumn: 21,
      endLine: 0,
      endColumn: 26,
    });
  });

  it("keeps authored relation generation stable when unrelated source changes", async () => {
    root = await makeProject({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    await scan(root, { full: true, kind: "fact-contract-relation-generation-test" });
    const db = await getDb(root);
    relate(db, {
      kind: "calls",
      srcPath: "src/a.ts",
      dstPath: "src/b.ts",
      evidence: "a calls b through fixture wiring",
    });
    const before = projectLegacyFacts(db, { workspaceId: "workspace-1" }).edges.find(
      (edge) => edge.kind === "call" && edge.producer.kind === "llm",
    );

    await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
    await scan(root, { kind: "fact-contract-relation-generation-test" });
    const after = projectLegacyFacts(db, { workspaceId: "workspace-1" }).edges.find(
      (edge) => edge.kind === "call" && edge.producer.kind === "llm",
    );

    expect(before?.generation).toEqual({ sourceSignature: null, runId: expect.any(String) });
    expect(after?.generation).toEqual(before?.generation);
    expect(after?.freshness).toBe("unverified");
  });
});

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
         src_path, src_line, src_column, name, specifier, dst_path,
         src_symbol, src_symbol_id, dst_line, dst_column, dst_symbol_id
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "src/main.ts",
        2,
        31,
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
      evidence: [{ anchor: { path: "src/main.ts", positionEncoding: "utf-16" } }],
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
      freshness: "current",
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
    expect(
      projectLegacyFacts(db, { workspaceId: "workspace-1" }).edges.find(
        (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
      )?.freshness,
    ).toBe("current");

    await writeFile(join(root, "src/store.ts"), "export function renamed() { return true; }\n");
    await scan(root, { kind: "fact-contract-freshness-test" });

    expect(
      projectLegacyFacts(db, { workspaceId: "workspace-1" }).edges.find(
        (edge) => edge.kind === "reference" && edge.producer.kind === "compiler",
      )?.freshness,
    ).toBe("stale");
  });
});

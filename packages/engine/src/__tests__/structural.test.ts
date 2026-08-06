import { afterEach, describe, expect, it } from "vitest";
import { PATTERNS, structuralSearch } from "../graph/structural.js";
import { loadNative } from "../scan/source.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/a.ts": `
export function risky(): void {
  try { go(); } catch (e) { }
  try { go(); } catch (e) { console.error(e); }
  throw new Error("boom");
}
export async function later(): Promise<void> { await Promise.resolve(); }
export function now(): void {}
export const loose: any = 1;
export const strict: string = "ok";
// TODO: make this less contrived
function go(): void {}
`,
  "src/b.py": `
def risky():
    try:
        go()
    except:
        pass
    try:
        go()
    except Exception:
        pass
    assert 1 == 1
`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

const withNative = loadNative() ? describe : describe.skip;

withNative("structural search", () => {
  it("matches by shape across languages", async () => {
    root = await makeProject(PROJECT);

    const thrown = await structuralSearch(root, { pattern: "throws" });
    expect(thrown.total).toBe(1);
    expect(thrown.matches[0]?.path).toBe("src/a.ts");
    expect(thrown.matches[0]?.text).toContain("boom");

    const except = await structuralSearch(root, { pattern: "python-bare-except" });
    expect(except.total).toBe(1);
    expect(except.matches[0]?.path).toBe("src/b.py");
  });

  it("makes named patterns as precise as their labels", async () => {
    root = await makeProject(PROJECT);

    expect((await structuralSearch(root, { pattern: "swallowed-errors" })).total).toBe(1);
    expect((await structuralSearch(root, { pattern: "async-functions" })).total).toBe(1);
    expect((await structuralSearch(root, { pattern: "any-annotations" })).total).toBe(1);
    expect((await structuralSearch(root, { pattern: "python-bare-except" })).total).toBe(1);
    expect((await structuralSearch(root, { pattern: "todo-comments" })).total).toBe(1);
  });

  it("filters full structural matches before the native result cap", async () => {
    root = await makeProject(PROJECT);

    const handled = await structuralSearch(root, {
      query: "(catch_clause body: (statement_block) @body)",
      text: "console.error",
      // The matching catch is second in source order, beyond the unfiltered cap.
      limit: 1,
    });
    expect(handled.total).toBe(1);
    expect(handled.truncated).toBe(false);
  });

  it("says when the requested result window is incomplete", async () => {
    root = await makeProject({
      "src/many.ts": "const alpha = 1; const beta = 2; const gamma = 3;\n",
    });

    const result = await structuralSearch(root, {
      query: "(identifier) @id",
      languages: ["typescript"],
      limit: 2,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("accepts a raw tree-sitter query", async () => {
    root = await makeProject(PROJECT);

    const calls = await structuralSearch(root, {
      query: "(call_expression) @call",
      languages: ["typescript"],
    });
    expect(calls.total).toBeGreaterThan(0);
    expect(calls.matches.every((match) => match.capture === "call")).toBe(true);
  });

  it("groups by file, because concentration is the usual question", async () => {
    root = await makeProject(PROJECT);
    const result = await structuralSearch(root, { pattern: "todo-comments" });
    expect(result.byFile.every((entry) => entry.count > 0)).toBe(true);
  });

  it("rejects an unknown pattern by name, listing the real ones", async () => {
    await expect(structuralSearch(".", { pattern: "nope" })).rejects.toThrow(/Unknown pattern/);
    expect(PATTERNS.length).toBeGreaterThan(4);
  });

  it("surfaces a malformed query as an error, never as zero matches", async () => {
    root = await makeProject(PROJECT);
    // "No matches" for a query that never compiled would read as "nothing
    // swallows errors here" — the silent pass this tool exists to catch.
    await expect(structuralSearch(root, { query: "(((" })).rejects.toThrow();
  });
});

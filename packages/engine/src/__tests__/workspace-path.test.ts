import { afterEach, describe, expect, it } from "vitest";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readWorkspaceSourceSlice,
  readWorkspaceText,
  resolveWorkspacePath,
  sourceFreshness,
} from "../lib/workspace-path.js";
import { cleanup, makeProject } from "./helpers.js";
import { getDb } from "../db/db.js";
import { scan } from "../scan/scan.js";

let project: string;
let outside: string;

afterEach(async () => {
  if (project) await cleanup(project);
  if (outside) await cleanup(outside);
});

describe("workspace path containment", () => {
  const root = join(process.cwd(), "fixture-workspace");

  it("resolves a path inside the workspace", () => {
    expect(resolveWorkspacePath(root, "src/main.ts")).toBe(join(root, "src/main.ts"));
  });

  it("rejects traversal and absolute paths outside the workspace", () => {
    expect(() => resolveWorkspacePath(root, "../secret.txt")).toThrow(/escapes workspace/);
    expect(() => resolveWorkspacePath(root, "/tmp/secret.txt")).toThrow(/escapes workspace/);
  });

  it("rejects symlinks that resolve outside the workspace", async () => {
    project = await makeProject({ "src/main.ts": "safe" });
    outside = await makeProject({ "secret.txt": "do not read" });
    await symlink(join(outside, "secret.txt"), join(project, "linked-secret.txt"));

    await expect(readWorkspaceText(project, "linked-secret.txt")).rejects.toThrow(
      /escapes workspace through a symlink/,
    );
  });

  it("returns a bounded, hashed source range for shared UI and MCP navigation", async () => {
    project = await makeProject({
      "src/main.ts": Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join("\n"),
    });

    const slice = await readWorkspaceSourceSlice(project, "src/main.ts", 10, 500);

    expect(slice).toMatchObject({
      path: "src/main.ts",
      startLine: 10,
      endLine: 409,
      totalLines: 450,
      truncated: true,
      characterTruncated: false,
    });
    expect(slice.content.split("\n")).toHaveLength(400);
    expect(slice.content.startsWith("line 10\nline 11")).toBe(true);
    expect(slice.contentSha).toMatch(/^[a-f0-9]{16}$/);
    await scan(project, { kind: "full" });
    const indexedSha = (await getDb(project)).get<{ content_sha: string }>(
      "SELECT content_sha FROM files WHERE path = ?",
      ["src/main.ts"],
    )?.content_sha;
    expect(indexedSha).toBe(slice.contentSha);

    await writeFile(join(project, "src/main.ts"), "changed after indexing\n");
    expect((await readWorkspaceSourceSlice(project, "src/main.ts")).contentSha).not.toBe(
      indexedSha,
    );
  });

  it("normalizes CRLF line endings in the displayed slice without changing signature parity", async () => {
    project = await makeProject({ "src/main.ts": "const one = 1;\r\nconst two = 2;\r\n" });

    const slice = await readWorkspaceSourceSlice(project, "src/main.ts", 1, 2);
    expect(slice.content).toBe("const one = 1;\nconst two = 2;");
    expect(slice.content).not.toContain("\r");

    await scan(project, { kind: "full" });
    const indexedSha = (await getDb(project)).get<{ content_sha: string }>(
      "SELECT content_sha FROM files WHERE path = ?",
      ["src/main.ts"],
    )?.content_sha;
    expect(slice.contentSha).toBe(indexedSha);
  });

  it("rejects invalid source ranges", async () => {
    project = await makeProject({ "src/main.ts": "one\ntwo\nthree" });

    await expect(readWorkspaceSourceSlice(project, "src/main.ts", 0, 1)).rejects.toThrow(
      /positive integer/,
    );
    await expect(readWorkspaceSourceSlice(project, "src/main.ts", 3, 2)).rejects.toThrow(
      /greater than or equal/,
    );
  });

  it("returns the end of a shortened current file when historical evidence is past EOF", async () => {
    project = await makeProject({ "src/main.ts": "one\ntwo\nthree" });

    await expect(readWorkspaceSourceSlice(project, "src/main.ts", 40, 42)).resolves.toMatchObject({
      startLine: 1,
      endLine: 3,
      totalLines: 3,
      truncated: true,
      content: "one\ntwo\nthree",
    });
  });

  it("rejects a file that grew beyond the scanner limit before loading it", async () => {
    project = await makeProject({
      "src/main.ts": "x".repeat(2 * 1024 * 1024 + 1),
    });

    await expect(readWorkspaceSourceSlice(project, "src/main.ts")).rejects.toThrow(
      /safe source-read limit/,
    );
  });

  it("distinguishes current, stale, and unattested evidence revisions", () => {
    expect(sourceFreshness("disk", "disk")).toBe("current");
    expect(sourceFreshness("disk", "older-index")).toBe("stale");
    expect(sourceFreshness("disk", "disk", "older-evidence")).toBe("stale");
    expect(sourceFreshness("disk", "older-index", "disk")).toBe("current");
    expect(sourceFreshness("disk", "disk", null)).toBe("unverified");
  });
});

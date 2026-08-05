import { afterEach, describe, expect, it } from "vitest";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { readWorkspaceText, resolveWorkspacePath } from "../lib/workspace-path.js";
import { cleanup, makeProject } from "./helpers.js";

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
});

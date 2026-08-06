import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkUiBootstrap } from "../daemon/auth.js";
import { isWorkspaceDirectory, requestPath, rootsIncludeWorkspace } from "../daemon/http.js";
import { cleanup, makeProject } from "./helpers.js";
import { join } from "node:path";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

function request(url: string, authorization?: string): IncomingMessage {
  return {
    url,
    headers: authorization ? { authorization } : {},
  } as IncomingMessage;
}

describe("daemon UI authentication", () => {
  it("requires the exact token before serving token-bearing HTML", () => {
    const token = "test-secret-token";
    expect(checkUiBootstrap(request("/"), token)).toMatchObject({ ok: false, status: 401 });
    expect(checkUiBootstrap(request("/?token=wrong"), token)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(checkUiBootstrap(request(`/?token=${token}`), token)).toEqual({ ok: true });
    expect(checkUiBootstrap(request("/", `Bearer ${token}`), token)).toEqual({ ok: true });
  });

  it("rejects malformed request targets before route dispatch", () => {
    expect(requestPath("//%")).toBeNull();
    expect(requestPath("/api/health?ok=1")).toBe("/api/health");
  });
});

describe("workspace registration", () => {
  it("rejects a regular file submitted as a workspace root", async () => {
    root = await makeProject({ "not-a-directory.txt": "x" });
    expect(isWorkspaceDirectory(join(root, "not-a-directory.txt"))).toBe(false);
    expect(isWorkspaceDirectory(root)).toBe(true);
    expect(isWorkspaceDirectory(join(root, "missing"))).toBe(false);
  });

  it("matches an MCP session's symlink alias to the canonical workspace", async () => {
    root = await makeProject({ "real/package.json": "{}" });
    const real = join(root, "real");
    const alias = join(root, "alias");
    const { symlink } = await import("node:fs/promises");
    await symlink(real, alias, "dir");

    expect(await rootsIncludeWorkspace(new Set([alias]), real)).toBe(true);
  });
});

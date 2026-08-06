import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkUiBootstrap } from "../daemon/auth.js";
import { isWorkspaceDirectory } from "../daemon/http.js";
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
});

describe("workspace registration", () => {
  it("rejects a regular file submitted as a workspace root", async () => {
    root = await makeProject({ "not-a-directory.txt": "x" });
    expect(isWorkspaceDirectory(join(root, "not-a-directory.txt"))).toBe(false);
    expect(isWorkspaceDirectory(root)).toBe(true);
    expect(isWorkspaceDirectory(join(root, "missing"))).toBe(false);
  });
});

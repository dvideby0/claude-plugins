import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkUiBootstrap } from "../daemon/auth.js";
import { createHttpServer } from "../daemon/http.js";
import { WorkspaceRegistry } from "../daemon/workspaces.js";
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
    const token = "test-secret-token";
    const handle = createHttpServer({
      token,
      registry: new WorkspaceRegistry(join(root, "workspaces.json")),
      bridge: { command: process.execPath, args: ["bridge.js"] },
      log: () => {},
    });
    const port = await handle.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ root: join(root, "not-a-directory.txt") }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/directory/) });
    } finally {
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
      handle.shutdown();
    }
  });
});

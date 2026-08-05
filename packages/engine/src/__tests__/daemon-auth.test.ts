import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { checkUiBootstrap } from "../daemon/auth.js";

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

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Database stores are app-owned now. Give every Vitest invocation an isolated
// SDLC home so parallel/local runs never touch a developer's real index.
process.env.SDLC_HOME = join(tmpdir(), `sdlc-vitest-${process.pid}-${randomUUID()}`);

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    globalSetup: ["./src/__tests__/global-setup.ts"],
    testTimeout: 30_000,
  },
});

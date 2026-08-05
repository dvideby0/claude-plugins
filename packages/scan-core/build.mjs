#!/usr/bin/env node

// Build the native module with cargo's target directory outside the package.
//
// The desktop app bundles this package verbatim from node_modules, so build
// intermediates must not live inside it — they weigh half a gigabyte and
// break codesigning. cargo reads .cargo/config.toml for that, but the napi
// CLI does not; CARGO_TARGET_DIR is the one knob both of them honor, and a
// script is the one way to set it that also works on the Windows CI runner.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const result = spawnSync("npx", ["napi", "build", "--platform", ...process.argv.slice(2)], {
  cwd: here,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CARGO_TARGET_DIR: join(here, "..", "..", "target", "scan-core") },
});

process.exit(result.status ?? 1);

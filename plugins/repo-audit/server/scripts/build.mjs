/**
 * Bundle the MCP server into a single committed file.
 * Vendored wasm/glue is loaded from server/vendor/ at runtime, not bundled.
 */
import { build } from "esbuild";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "build", "index.js");

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: false,
  sourcemap: false,
});

const { size } = await stat(outfile);
console.log(`built build/index.js (${(size / 1024).toFixed(0)} KB)`);

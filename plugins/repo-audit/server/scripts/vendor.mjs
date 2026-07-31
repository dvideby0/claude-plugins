/**
 * Copy runtime wasm assets into server/vendor/ so the shipped plugin needs
 * no npm install. Run after changing sql.js or tree-sitter versions.
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vendorDir = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");

const treeSitterDir = dirname(
  require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js"),
);
const sqlDir = dirname(require.resolve("sql.js"));

// The glue files are CommonJS; the .cjs extension keeps Node from treating
// them as ESM under this package's "type": "module".
const assets = [
  [join(treeSitterDir, "tree-sitter.js"), "tree-sitter.cjs"],
  [join(treeSitterDir, "tree-sitter.wasm"), "tree-sitter.wasm"],
  [join(treeSitterDir, "tree-sitter-typescript.wasm"), "tree-sitter-typescript.wasm"],
  [join(treeSitterDir, "tree-sitter-tsx.wasm"), "tree-sitter-tsx.wasm"],
  [join(treeSitterDir, "tree-sitter-python.wasm"), "tree-sitter-python.wasm"],
  [join(sqlDir, "sql-wasm.js"), "sql-wasm.cjs"],
  [join(sqlDir, "sql-wasm.wasm"), "sql-wasm.wasm"],
];

await mkdir(vendorDir, { recursive: true });
for (const [src, name] of assets) {
  await copyFile(src, join(vendorDir, name));
}

let total = 0;
for (const f of await readdir(vendorDir)) {
  total += (await stat(join(vendorDir, f))).size;
}
console.log(
  `vendored ${assets.length} assets -> ${(total / 1024 / 1024).toFixed(1)} MB`,
);

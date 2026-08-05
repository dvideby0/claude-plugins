#!/usr/bin/env node

/**
 * End-to-end smoke test.
 *
 * Spawns the bridge exactly the way a harness does — over stdio, with cwd set
 * to the project — and drives it. Nothing here talks to the daemon directly,
 * so a pass means the whole chain works: bridge -> discovery -> HTTP -> MCP
 * -> engine -> store.
 *
 * Requires a running daemon: npm run daemon
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findDaemon } from "@sdlc/protocol";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = join(REPO, "packages", "mcp-bridge", "dist", "index.js");
const target = process.argv[2] ?? REPO;

function head(text) {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`);
}

const daemon = await findDaemon();
if (!daemon) {
  console.error("No engine running. Start one with: npm run daemon");
  process.exit(1);
}
console.log(`engine v${daemon.version} on port ${daemon.port} (pid ${daemon.pid})`);

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    cwd: target,
    // The SDK intentionally forwards only a minimal environment by default.
    // Keep test overrides such as SDLC_HOME so the bridge discovers the same
    // isolated daemon that this parent process just verified.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    stderr: "inherit",
  }),
);

head(`tools/list`);
const { tools } = await client.listTools();
console.log(tools.map((tool) => `  ${tool.name}`).join("\n"));
if (tools.length === 0) throw new Error("Bridge returned no tools.");

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const payload = JSON.parse(result.content[0].text);
  if (payload.error) throw new Error(`${name}: ${payload.message}`);
  return payload;
};

head(`audit_scan  (no projectRoot given — the bridge must inject ${target})`);
const scan = await call("audit_scan");
const languages = Object.entries(scan.languages ?? {})
  .map(([language, count]) => `${language} ${count}`)
  .join(", ");
console.log(
  `  ${scan.filesParsed}/${scan.filesTotal} files parsed · ` +
    `${scan.symbols} symbols · ${scan.edges} edges · ${languages}`,
);

head("audit_status");
const status = await call("audit_status");
for (const key of ["projectRoot", "indexedFiles", "symbols", "edges", "suggestedNext"]) {
  console.log(`  ${key.padEnd(13)} ${status[key]}`);
}

if (status.projectRoot !== target) {
  throw new Error(`Bridge sent the wrong root: ${status.projectRoot} !== ${target}`);
}
if (status.indexedFiles === 0) throw new Error("Scan indexed nothing.");

head("audit_query  (rule index)");
const rules = await call("audit_query", { kind: "rule" });
console.log(`  ${rules.rows.length} rules available`);
if (rules.rows.length === 0) throw new Error("No rules — engine content/ not found.");

await client.close();
console.log("\n\x1b[32mPASS\x1b[0m — bridge, daemon, engine and store all reachable.\n");

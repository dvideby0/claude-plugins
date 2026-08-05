#!/usr/bin/env node

/**
 * Single-project stdio entry.
 *
 * The daemon is the supported path; this exists so the engine can be driven
 * directly in CI and tests, where one repository and one process is the whole
 * story and there is nothing to keep warm.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp/server.js";

const server = createMcpServer({ defaultRoot: process.cwd() });

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`engine (stdio) failed to start: ${error?.stack ?? error}\n`);
  process.exit(1);
});

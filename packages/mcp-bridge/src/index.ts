#!/usr/bin/env node

/**
 * The plugin's entire runtime.
 *
 * Harnesses spawn one of these per session. It holds no index and parses
 * nothing — it finds the daemon and forwards. That is what keeps the plugin
 * a few kilobytes instead of a few megabytes, and what lets every session
 * share one warm index instead of building its own.
 *
 * The daemon is looked up on each request rather than once at startup, so
 * launching the app after the harness still works without a restart. That
 * promise needs one more piece: a harness lists tools exactly once, so when
 * that list was served while the engine was down, the bridge polls for the
 * engine and announces `tools/list_changed` the moment it appears — without
 * it, a session started before the app has zero tools forever.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { baseUrl, findDaemon } from "@sdlc/protocol";

const VERSION = "0.1.0";

const NO_DAEMON =
  "The SDLC engine is not running. Open the SDLC desktop app to start it, then retry — " +
  "no need to restart this session.";

/** The repository this session is working in. */
const PROJECT_ROOT = process.env.SDLC_PROJECT_ROOT ?? process.cwd();

function note(message: string): void {
  // stdout carries JSON-RPC and nothing else.
  process.stderr.write(`[sdlc-bridge] ${message}\n`);
}

let client: Client | null = null;
let connecting: Promise<Client | null> | null = null;

/** Connect on demand, and drop a dead connection so the next call retries. */
function connect(): Promise<Client | null> {
  if (client) return Promise.resolve(client);
  // Two concurrent first requests must share one attempt — the loser of a
  // connect race would leak its Client and null out the winner's on close.
  if (connecting) return connecting;

  connecting = (async (): Promise<Client | null> => {
    const daemon = await findDaemon();
    if (!daemon) return null;

    const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl(daemon)), {
      requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
    });

    const connected = new Client({ name: "sdlc-bridge", version: VERSION });
    connected.onclose = (): void => {
      // Only forget the client this close belongs to — a late close from a
      // replaced connection must not null out its successor.
      if (client === connected) client = null;
    };

    try {
      await connected.connect(transport);
    } catch (error) {
      note(`could not reach the engine: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    note(`connected to engine on port ${daemon.port}`);
    client = connected;
    return client;
  })().finally(() => {
    connecting = null;
  });

  return connecting;
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: true, message }, null, 2) }],
    isError: true,
  };
}

const server = new Server(
  { name: "sdlc", version: VERSION },
  { capabilities: { tools: { listChanged: true } } },
);

/**
 * When tools/list was answered with nothing, watch for the engine and tell
 * the harness to ask again. Polling stops the moment a list succeeds.
 */
let watching: NodeJS.Timeout | null = null;
function watchForEngine(): void {
  if (watching) return;
  watching = setInterval(() => {
    void (async () => {
      const upstream = await connect();
      if (!upstream) return;
      if (watching) clearInterval(watching);
      watching = null;
      note("engine appeared — announcing tools/list_changed");
      void server.sendToolListChanged();
    })();
  }, 3000);
  watching.unref();
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const upstream = await connect();
  if (!upstream) {
    note("tools/list requested while the engine is down — will announce when it appears");
    watchForEngine();
    return { tools: [] as Tool[] };
  }
  try {
    return await upstream.listTools();
  } catch (error) {
    client = null;
    note(`tools/list failed: ${error instanceof Error ? error.message : String(error)}`);
    watchForEngine();
    return { tools: [] as Tool[] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const upstream = await connect();
  if (!upstream) return errorResult(NO_DAEMON);

  // The engine serves many repositories, so it needs to be told which one.
  // The harness spawns us inside the project, so our cwd is the answer.
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const withRoot = "projectRoot" in args ? args : { ...args, projectRoot: PROJECT_ROOT };

  try {
    return (await upstream.callTool({
      name: request.params.name,
      arguments: withRoot,
    })) as CallToolResult;
  } catch (error) {
    client = null;
    // The commonest failure is the daemon stopping mid-session. That case
    // deserves the standard guidance, not a bare "fetch failed".
    if (!(await findDaemon())) return errorResult(NO_DAEMON);
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Engine call failed: ${message}. Retry — the engine is running.`);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  note(`ready — project root ${PROJECT_ROOT}`);
}

main().catch((error) => {
  note(`failed to start: ${error?.stack ?? error}`);
  process.exit(1);
});

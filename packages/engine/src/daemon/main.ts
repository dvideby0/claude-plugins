#!/usr/bin/env node

/**
 * The engine daemon.
 *
 * One per machine. It outlives any single agent session, which is the whole
 * point: indexes stay warm, work continues between sessions, and every
 * harness talks to the same store instead of each spawning its own copy.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearDaemon, logFile, ping, readDaemon, stateDir, writeDaemon } from "@sdlc/protocol";
import { ENGINE_VERSION } from "../mcp/server.js";
import type { BridgeCommand } from "./harnesses.js";
import { createHttpServer } from "./http.js";
import { writeLauncher } from "./launcher.js";
import { WorkspaceRegistry } from "./workspaces.js";

/** Stable by default so the UI keeps one URL across restarts. */
const DEFAULT_PORT = Number(process.env.SDLC_PORT ?? 7420);

function openLog(): WriteStream {
  return createWriteStream(logFile(), { flags: "a" });
}

/**
 * What a harness should spawn.
 *
 * The launcher is a fixed path the daemon keeps pointed at the current
 * install, so harness config written today still works after an upgrade.
 */
async function resolveBridge(): Promise<BridgeCommand> {
  const require = createRequire(import.meta.url);
  const node = process.env.SDLC_BRIDGE_COMMAND ?? process.execPath;

  const script =
    process.env.SDLC_BRIDGE_SCRIPT ??
    (() => {
      try {
        return require.resolve("@sdlc/mcp-bridge");
      } catch {
        // Running from source without the workspace link — fall back to a sibling.
        const here = dirname(fileURLToPath(import.meta.url));
        return join(here, "..", "..", "..", "mcp-bridge", "dist", "index.js");
      }
    })();

  return writeLauncher({
    node,
    script,
    // Electron's binary only behaves like node with this set.
    electron: Boolean(process.env.SDLC_BRIDGE_ELECTRON),
  });
}

async function main(): Promise<void> {
  await mkdir(stateDir(), { recursive: true });

  // One daemon per machine. A dead pid is cleaned up by readDaemon(); a live
  // pid still has to answer — after a reboot the recorded pid usually belongs
  // to some unrelated process, and treating that as "already running" bricks
  // startup until someone finds and deletes daemon.json by hand.
  const running = await readDaemon();
  if (running) {
    if (await ping(running, 5000)) {
      process.stderr.write(
        `An engine is already running (pid ${running.pid}, port ${running.port}).\n`,
      );
      process.exit(3);
    }
    process.stderr.write(
      `Ignoring stale daemon.json (pid ${running.pid} is not an engine).\n`,
    );
    await clearDaemon();
  }

  const log = openLog();
  const write = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`;
    log.write(line);
    process.stderr.write(line);
  };

  const token = randomBytes(32).toString("hex");
  const registry = new WorkspaceRegistry();
  const bridge = await resolveBridge();

  const handle = createHttpServer({ token, registry, bridge, log: write });
  const { server, listen } = handle;
  const port = await listen(DEFAULT_PORT);

  await writeDaemon({
    pid: process.pid,
    port,
    token,
    version: ENGINE_VERSION,
    startedAt: new Date().toISOString(),
  });

  // Two engines starting in the same instant both pass the check above
  // before either publishes. Whoever's write survives owns the machine; the
  // other bows out rather than run as an undiscoverable rival sharing the
  // same stores.
  const published = await readDaemon();
  if (published && published.pid !== process.pid) {
    write(`another engine won the start race (pid ${published.pid}); exiting`);
    server.close();
    process.exit(3);
  }

  write(`engine ${ENGINE_VERSION} listening on http://127.0.0.1:${port}`);
  write(`bridge command: ${bridge.command} ${bridge.args.join(" ")}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    write(`received ${signal}, shutting down`);

    // Kill draw agents now — the close event waits for connections to drain,
    // and the forced-exit fallback below never fires it at all.
    handle.shutdown();

    server.close(() => {
      void clearDaemon().finally(() => {
        log.end();
        process.exit(0);
      });
    });

    // Do not hang forever on a client holding a connection open.
    setTimeout(() => {
      void clearDaemon().finally(() => process.exit(0));
    }, 3000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    write(`uncaught exception: ${error.stack ?? error.message}`);
  });
}

main().catch(async (error) => {
  process.stderr.write(`engine failed to start: ${error?.stack ?? error}\n`);
  await clearDaemon().catch(() => {});
  process.exit(1);
});

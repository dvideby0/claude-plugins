#!/usr/bin/env node

/**
 * The engine daemon.
 *
 * One per machine. It outlives any single agent session, which is the whole
 * point: indexes stay warm, work continues between sessions, and every
 * harness talks to the same store instead of each spawning its own copy.
 */

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearDaemon, logFile, ping, readDaemon, stateDir, writeDaemon } from "@sdlc/protocol";
import { ENGINE_VERSION } from "../mcp/server.js";
import { requireNative } from "../scan/source.js";
import type { BridgeCommand } from "./harnesses.js";
import { createHttpServer } from "./http.js";
import { writeLauncher } from "./launcher.js";
import { openDaemonLog, safeStreamWriter } from "./log.js";
import {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
  type DaemonLock,
} from "./lock.js";
import { WorkspaceRegistry } from "./workspaces.js";

/** Stable by default so the UI keeps one URL across restarts. */
const DEFAULT_PORT = Number(process.env.SDLC_PORT ?? 7420);
let ownership: DaemonLock | null = null;
let published = false;
const writeStderr = safeStreamWriter(process.stderr);

async function relinquishOwnership(): Promise<void> {
  if (!ownership) return;
  const lock = ownership;
  try {
    if (published) await clearDaemon();
  } finally {
    published = false;
    await lock.release();
    if (ownership === lock) ownership = null;
  }
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
  // The daemon must never advertise a partially functional indexing engine.
  requireNative();
  await mkdir(stateDir(), { recursive: true });

  // Fast path for the common case. Do not remove an unresponsive record yet:
  // its owner may be between publishing and listening, and the ownership lock
  // below is the authoritative answer during that startup window.
  const running = await readDaemon();
  if (running) {
    if (await ping(running, 5000)) {
      writeStderr(
        `An engine is already running (pid ${running.pid}, port ${running.port}).\n`,
      );
      process.exit(3);
    }
    writeStderr(`Found an unresponsive daemon record for pid ${running.pid}.\n`);
  }

  // daemon.json is discovery, not mutual exclusion. Hold an atomic lock for
  // the whole process lifetime so two simultaneous starts cannot both open
  // and mutate the same SQLite stores.
  ownership = await acquireDaemonLock();

  // A daemon from an older release may not own a lock. Check again after
  // acquiring so we remain compatible without reviving the start race.
  const legacyRunning = await readDaemon();
  if (legacyRunning) {
    if (await ping(legacyRunning, 5000)) {
      writeStderr(
        `An engine is already running (pid ${legacyRunning.pid}, port ${legacyRunning.port}).\n`,
      );
      await relinquishOwnership();
      process.exit(3);
      return;
    }
    await clearDaemon();
  }

  const log = openDaemonLog(logFile());
  const write = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`;
    log.write(line);
    writeStderr(line);
  };

  const token = randomBytes(32).toString("hex");
  const registry = new WorkspaceRegistry();
  const bridge = await resolveBridge();

  let shuttingDown = false;
  let handle: ReturnType<typeof createHttpServer>;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    write(`received ${signal}, shutting down`);

    // Kill draw and review agents now — the close event waits for connections
    // to drain, and the forced-exit fallback below never fires it at all.
    handle.shutdown();

    handle.server.close(() => {
      void relinquishOwnership().finally(() => {
        log.close();
        process.exit(exitCode);
      });
    });

    // Do not hang forever on a client holding a connection open.
    setTimeout(() => {
      void relinquishOwnership().finally(() => process.exit(exitCode));
    }, 3000).unref();
  };

  handle = createHttpServer({
    token,
    registry,
    bridge,
    log: write,
    onShutdownRequested: () => shutdown("control request"),
  });
  const { listen } = handle;
  const port = await listen(DEFAULT_PORT);

  await writeDaemon({
    pid: process.pid,
    port,
    token,
    version: ENGINE_VERSION,
    startedAt: new Date().toISOString(),
  });
  published = true;

  write(`engine ${ENGINE_VERSION} listening on http://127.0.0.1:${port}`);
  write(`bridge command: ${bridge.command} ${bridge.args.join(" ")}`);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    write(`uncaught exception: ${error.stack ?? error.message}`);
    shutdown("uncaught exception", 1);
  });
}

main().catch(async (error) => {
  writeStderr(`engine failed to start: ${error?.stack ?? error}\n`);
  await relinquishOwnership().catch(() => {});
  process.exit(error instanceof DaemonAlreadyRunningError ? 3 : 1);
});

/**
 * The desktop shell.
 *
 * It owns the engine's lifecycle and nothing else: start it if it is not
 * already running, wait for it to answer, then show its UI. The window is a
 * view onto the daemon, not a second implementation of it — which is why an
 * engine started from a terminal is adopted rather than duplicated.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { baseUrl, findDaemon, readDaemon, type DaemonInfo } from "@sdlc/protocol";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/** Only an engine we started is ours to stop. */
let child: ChildProcess | null = null;
let window: BrowserWindow | null = null;

function enginePath(): string {
  try {
    return require.resolve("@sdlc/engine");
  } catch {
    return join(HERE, "..", "..", "..", "packages", "engine", "dist", "daemon", "main.js");
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Electron's binary is our node. Telling the daemon so means the bridge it
 * registers with each harness points at something that will still exist
 * after this app is installed somewhere else.
 */
function engineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    SDLC_BRIDGE_COMMAND: process.execPath,
    SDLC_BRIDGE_ELECTRON: "1",
  };
}

function startEngine(): void {
  const script = enginePath();
  child = spawn(process.execPath, [script], {
    env: engineEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[engine] ${chunk.toString()}`);
  });

  child.on("exit", (code, signal) => {
    process.stderr.write(`[engine] exited (code ${code ?? "null"}, signal ${signal ?? "none"})\n`);
    child = null;
  });
}

/** Wait for an engine — ours or one already running — to answer. */
async function waitForEngine(timeoutMs = 20_000): Promise<DaemonInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const daemon = await findDaemon();
    if (daemon) return daemon;
    await sleep(250);
  }
  throw new Error("The engine did not start within 20 seconds.");
}

async function ensureEngine(): Promise<DaemonInfo> {
  const existing = await findDaemon();
  if (existing) {
    process.stderr.write(`[shell] adopting engine on port ${existing.port}\n`);
    return existing;
  }
  startEngine();
  return waitForEngine();
}

async function createWindow(daemon: DaemonInfo): Promise<void> {
  window = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 620,
    title: "SDLC",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#16150f",
    show: false,
    webPreferences: {
      preload: join(HERE, "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });

  // Links to anywhere else open in the real browser, never in the shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Same-window navigation gets the same rule: the shell shows the engine and
  // nothing else. The preload's IPC (openPath — "launch any local file") rides
  // along to whatever origin this window displays, so a stray link in
  // engine-rendered content must not carry it to a foreign page.
  const engineOrigin = new URL(baseUrl(daemon)).origin;
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === engineOrigin) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  await window.loadURL(baseUrl(daemon));
}

function showStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(
    "SDLC could not start",
    `${message}\n\nThe engine log is at ~/.sdlc/daemon.log.`,
  );
}

ipcMain.handle("sdlc:pick-directory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a repository",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("sdlc:open-path", async (_event, target: unknown) => {
  if (typeof target !== "string" || target.length === 0) return false;
  const error = await shell.openPath(target);
  return error === "";
});

// A second launch should focus the existing window, not start a rival engine.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    try {
      const daemon = await ensureEngine();
      await createWindow(daemon);
    } catch (error) {
      showStartupFailure(error);
      app.quit();
    }

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      const daemon = await readDaemon();
      if (daemon) await createWindow(daemon);
    });
  });

  app.on("window-all-closed", () => {
    // Quitting on macOS too: the engine is the product, and leaving an
    // invisible app running with no window is how you get two of them.
    app.quit();
  });

  app.on("before-quit", () => {
    // Adopted engines keep running — we did not start them.
    if (child) {
      process.stderr.write("[shell] stopping the engine we started\n");
      child.kill("SIGTERM");
    }
  });
}

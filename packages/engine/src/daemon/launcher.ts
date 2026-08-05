/**
 * A stable command for harnesses to spawn.
 *
 * Harness config is written once and read for months. Pointing it straight at
 * the bridge script means the entry goes stale the moment the app is updated,
 * moved, or has its node_modules reinstalled — and a broken MCP server is
 * silent until someone wonders why the tools vanished.
 *
 * So the daemon owns a small launcher at a fixed path and rewrites it on every
 * startup. Harnesses point at the launcher; the launcher points at whatever is
 * current.
 */

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "@sdlc/protocol";

export interface LauncherTarget {
  /** Absolute path to the node (or Electron-as-node) binary. */
  node: string;
  /** Absolute path to the bridge entry script. */
  script: string;
  /** Set when `node` is an Electron binary being used as node. */
  electron: boolean;
}

export function launcherPath(): string {
  return process.platform === "win32"
    ? join(stateDir(), "bin", "sdlc-bridge.cmd")
    : join(stateDir(), "bin", "sdlc-bridge");
}

function shellScript(target: LauncherTarget): string {
  return [
    "#!/bin/sh",
    "# Written by the SDLC engine. Do not edit — it is regenerated on startup.",
    // `exec VAR=value cmd` is not valid shell — exec takes a command, not an
    // assignment prefix. The variable has to be exported first.
    ...(target.electron ? ["ELECTRON_RUN_AS_NODE=1", "export ELECTRON_RUN_AS_NODE"] : []),
    `exec ${JSON.stringify(target.node)} ${JSON.stringify(target.script)} "$@"`,
    "",
  ].join("\n");
}

function cmdScript(target: LauncherTarget): string {
  return [
    "@echo off",
    "REM Written by the SDLC engine. Do not edit - it is regenerated on startup.",
    ...(target.electron ? ["set ELECTRON_RUN_AS_NODE=1"] : []),
    `"${target.node}" "${target.script}" %*`,
    "",
  ].join("\r\n");
}

/**
 * Write the launcher and return the command a harness should run.
 *
 * Falls back to invoking the script directly if the launcher cannot be
 * written — a connection that works until the next upgrade beats none at all.
 */
export async function writeLauncher(
  target: LauncherTarget,
): Promise<{ command: string; args: string[]; env?: Record<string, string> }> {
  const path = launcherPath();
  try {
    await mkdir(join(stateDir(), "bin"), { recursive: true });
    // Written to the side and renamed into place: this file is exec'd by
    // arbitrary harness sessions at arbitrary times, and an in-place rewrite
    // has a window where a session execs a truncated or not-yet-executable
    // script — a silently dead MCP server for that whole session.
    const tmp = `${path}.tmp`;
    if (process.platform === "win32") {
      await writeFile(tmp, cmdScript(target), "utf-8");
    } else {
      await writeFile(tmp, shellScript(target), "utf-8");
      await chmod(tmp, 0o755);
    }
    await rename(tmp, path);
    return { command: path, args: [] };
  } catch {
    return target.electron
      ? { command: target.node, args: [target.script], env: { ELECTRON_RUN_AS_NODE: "1" } }
      : { command: target.node, args: [target.script] };
  }
}

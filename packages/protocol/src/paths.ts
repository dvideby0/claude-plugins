/**
 * Every path the three processes agree on. The engine writes these, the
 * bridge and desktop app read them, so they live here rather than in any
 * one of them.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all local state. Override with SDLC_HOME (tests, portable installs). */
export function stateDir(): string {
  return process.env.SDLC_HOME ?? join(homedir(), ".sdlc");
}

/** Written by a running daemon, removed on clean shutdown. Mode 0600. */
export function daemonFile(): string {
  return join(stateDir(), "daemon.json");
}

/** Atomic cross-process ownership marker held for the daemon's lifetime. */
export function daemonLockDir(): string {
  return join(stateDir(), "daemon.lock");
}

/** The set of directories the user has allowed the engine to index. */
export function workspacesFile(): string {
  return join(stateDir(), "workspaces.json");
}

/** Per-workspace stores, keyed by workspace id. */
export function storeDir(): string {
  return join(stateDir(), "stores");
}

/** App-owned outputs and manifests produced by external analysis providers. */
export function providersDir(): string {
  return join(stateDir(), "providers");
}

/** Daemon log, tailed by the desktop app. */
export function logFile(): string {
  return join(stateDir(), "daemon.log");
}

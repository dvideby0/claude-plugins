/**
 * The contract between the engine, the bridge and the desktop app.
 */

/** What a running daemon publishes so other processes can reach it. */
export interface DaemonInfo {
  pid: number;
  port: number;
  /** Bearer token for non-same-origin callers (the bridge). */
  token: string;
  version: string;
  startedAt: string;
}

/** A directory the user has allowed the engine to index. */
export interface Workspace {
  id: string;
  root: string;
  name: string;
  addedAt: string;
  lastIndexedAt: string | null;
}

export interface WorkspaceStatus extends Workspace {
  indexedFiles: number;
  symbols: number;
  edges: number;
  openFindings: number;
  /** What the engine thinks should happen next, e.g. "audit_scan". */
  suggestedNext: string | null;
  indexing: boolean;
}

export interface EngineStatus {
  version: string;
  startedAt: string;
  pid: number;
  port: number;
  workspaces: number;
  /** Repositories currently being watched for changes. */
  watching: number;
}

/** A coding CLI found on this machine. */
export interface DetectedHarness {
  id: "claude-code" | "codex";
  name: string;
  /** Absolute path to the executable, or null when not found. */
  binPath: string | null;
  version: string | null;
  /** Config file this harness reads MCP servers from. */
  configPath: string;
  /** Whether our MCP server is already registered there. */
  connected: boolean;
}

export const HARNESS_IDS = ["claude-code", "codex"] as const;

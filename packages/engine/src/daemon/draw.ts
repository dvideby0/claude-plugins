/**
 * Running the coding agent from the app.
 *
 * Everything else here is deterministic: the scan reads files and writes rows.
 * This is the one place the daemon reaches back out to the harness and asks it
 * to think — the pass that turns the machine's index into a map a person would
 * draw.
 *
 * It spawns the same CLI the user already has installed rather than talking to
 * a model directly. That means the drawing runs under their auth, their model
 * choice and their MCP config, and it reaches the engine through the identical
 * tools an interactive session uses. There is no second code path to keep
 * honest.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readContent } from "../content.js";
import { platformCommand, spawnEnv } from "../lib/exec.js";
import type { BridgeCommand } from "./harnesses.js";

export type DrawPhase = "scanning" | "drawing" | "done" | "failed";

export interface DrawEvent {
  at: string;
  text: string;
}

export interface HarnessInvocation {
  bin: string;
  args: (prompt: string, bridge: BridgeCommand) => string[];
}

/** Exact engine surface needed by the unattended map prompt. */
export const MAP_MCP_TOOLS = [
  "map",
  "map_drift",
  "describe_component",
  "describe_flow",
  "finalize_map",
  "tag",
  "gaps",
  "flow",
  "trace",
  "audit_query",
  "read_file",
  "context",
  "relations",
  "remember",
] as const;

/**
 * How each CLI is asked to run one prompt to completion and exit.
 *
 * The tool allow-lists are deliberately narrow. This runs unattended, so the
 * agent is given exactly what the drawing pass needs. Repository reads go
 * through the engine so realpath checks enforce the workspace boundary.
 */
const INVOCATIONS: Record<string, HarnessInvocation> = {
  "claude-code": {
    bin: "claude",
    args: (prompt, bridge) => [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // `--allowedTools` controls approval, not availability. Disable every
      // built-in tool, then expose only the workspace-confined SDLC server.
      "--tools",
      "",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          sdlc: {
            command: bridge.command,
            args: bridge.args,
            ...(bridge.env ? { env: bridge.env } : {}),
          },
        },
      }),
      "--allowedTools",
      ...MAP_MCP_TOOLS.map((tool) => `mcp__sdlc__${tool}`),
    ],
  },
  codex: {
    bin: "codex",
    args: (prompt, bridge) => [
      "exec",
      // Authentication still comes from CODEX_HOME, but no user config means
      // no unrelated MCP servers, hooks, or repository-specific settings are
      // inherited by this unattended run.
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      // The map pass has one read surface: the SDLC MCP, whose read_file tool
      // rejects paths outside this workspace. Codex's read-only sandbox still
      // allows shell reads from the rest of the user's account, so remove the
      // command tools rather than treating read-only as a confidentiality
      // boundary. Disable other optional tool surfaces for the same reason.
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--disable",
      "multi_agent",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "browser_use",
      "--disable",
      "in_app_browser",
      "-c",
      "tools.web_search=false",
      "-c",
      "tools.view_image=false",
      "--sandbox",
      "read-only",
      "-c",
      codexMcpOverride(bridge),
      prompt,
    ],
  },
};

/**
 * Replace the entire MCP table for an unattended Codex run.
 *
 * Limiting only `mcp_servers.sdlc.enabled_tools` leaves every other server in
 * the user's normal config loaded. Repository text is untrusted, and Codex's
 * filesystem sandbox cannot contain side effects performed by a remote MCP.
 * `--ignore-user-config` starts from an empty table while preserving auth;
 * this override then makes SDLC the only server visible to the child.
 */
export function codexMcpOverride(bridge: BridgeCommand): string {
  const string = (value: string): string => JSON.stringify(value);
  const args = bridge.args.map(string).join(", ");
  const tools = MAP_MCP_TOOLS.map(string).join(", ");
  const fields = [
    `command = ${string(bridge.command)}`,
    `args = [${args}]`,
    `enabled_tools = [${tools}]`,
  ];
  const environment = Object.entries(bridge.env ?? {});
  if (environment.length > 0) {
    fields.push(
      `env = { ${environment.map(([key, value]) => `${string(key)} = ${string(value)}`).join(", ")} }`,
    );
  }
  return `mcp_servers = { sdlc = { ${fields.join(", ")} } }`;
}

/** Exposed so the capability ceiling is regression-tested without spawning a CLI. */
export function drawInvocationArgs(
  harness: string,
  prompt: string,
  bridge: BridgeCommand = { command: "sdlc-bridge", args: [] },
): string[] {
  const invocation = INVOCATIONS[harness];
  if (!invocation) throw new Error(`Unsupported draw harness: ${harness}`);
  return invocation.args(prompt, bridge);
}

export function supportedHarnesses(): string[] {
  return Object.keys(INVOCATIONS);
}

export interface DrawOptions {
  harness: string;
  root: string;
  bridge: BridgeCommand;
  onEvent: (text: string) => void;
}

export interface DrawHandle {
  child: ChildProcess;
  finished: Promise<{ ok: boolean; summary: string }>;
}

/**
 * Pull a human-readable line out of Claude's stream-json.
 *
 * Best-effort by design: the point is a live sense of what the agent is doing,
 * so an unrecognised event shape is skipped rather than failing the run.
 */
function describeEvent(line: string): string | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const message = event.message as { content?: unknown[] } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];

  for (const part of content) {
    const block = part as { type?: string; name?: string; text?: string; input?: unknown };
    if (block.type === "tool_use" && block.name) {
      const name = block.name.replace(/^mcp__sdlc__/, "");
      const input = block.input as Record<string, unknown> | undefined;
      const subject =
        (input?.name as string) ?? (input?.path as string) ?? (input?.description as string) ?? "";
      return subject ? `${name} · ${String(subject).slice(0, 60)}` : name;
    }
    if (block.type === "text" && block.text?.trim()) {
      return block.text.trim().split("\n")[0]?.slice(0, 140) ?? null;
    }
  }

  if (event.type === "result") {
    return typeof event.result === "string" ? event.result.split("\n")[0]!.slice(0, 200) : "done";
  }
  return null;
}

/**
 * Turn a harness's own failure into something the person can act on.
 *
 * These surface in the app, where "exited with code 1" is useless. The two
 * that actually happen are an expired login and a missing binary, and both
 * have a one-line fix worth stating.
 */
function explain(bin: string, output: string): string | null {
  if (/401|OAuth|authenticate|not logged in/i.test(output)) {
    return `${bin} is not signed in — its login has expired. Run \`${bin}\` in a terminal and sign in, then try again.`;
  }
  if (/ENOENT|command not found/i.test(output)) {
    return `${bin} is not on PATH. Install it, or connect a different agent in Settings.`;
  }
  return null;
}

/** Kick off the drawing pass. Resolves when the agent exits. */
export async function drawMap(options: DrawOptions): Promise<DrawHandle> {
  const invocation = INVOCATIONS[options.harness];
  if (!invocation) {
    throw new Error(
      `Cannot drive "${options.harness}". Supported: ${supportedHarnesses().join(", ")}.`,
    );
  }

  const prompt = await readContent("prompts/map.md");
  const rawArgs = drawInvocationArgs(options.harness, prompt, options.bridge);
  const command = platformCommand(invocation.bin, rawArgs);
  const child = spawn(command.command, command.args, {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv(),
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });

  let tail = "";
  let transcript = "";
  // The transcript only feeds the failure explanation, so a bounded tail is
  // enough — an agent's full verbose stream can run to hundreds of MB, held
  // in a daemon that never exits.
  const TRANSCRIPT_CAP = 512 * 1024;
  const consume = (chunk: Buffer, isError: boolean): void => {
    const text = chunk.toString();
    transcript += text;
    if (transcript.length > TRANSCRIPT_CAP) transcript = transcript.slice(-TRANSCRIPT_CAP);
    tail += text;
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const described = describeEvent(trimmed);
      if (described) options.onEvent(described);
      else if (isError) options.onEvent(trimmed.slice(0, 200));
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => consume(chunk, false));
  child.stderr?.on("data", (chunk: Buffer) => consume(chunk, true));

  const finished = new Promise<{ ok: boolean; summary: string }>((resolve) => {
    child.on("error", (error) => {
      resolve({
        ok: false,
        summary: explain(invocation.bin, error.message) ?? `Could not start ${invocation.bin}: ${error.message}`,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, summary: "Map drawn." });
        return;
      }
      resolve({
        ok: false,
        summary:
          explain(invocation.bin, transcript) ??
          `${invocation.bin} exited with code ${code ?? "unknown"}.`,
      });
    });
  });

  return { child, finished };
}

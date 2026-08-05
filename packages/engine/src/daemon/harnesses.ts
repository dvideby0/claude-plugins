/**
 * Finding the coding CLIs on this machine, and wiring them to the engine.
 *
 * Both harnesses get the stdio bridge rather than an HTTP URL: the bridge
 * reads the daemon's port at spawn time, so a restart on a different port
 * does not leave stale config behind.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DetectedHarness } from "@sdlc/protocol";
import { platformCommand, spawnEnv, which } from "../lib/exec.js";

const run = promisify(execFile);

/** Name the engine registers itself under in both harnesses. */
export const SERVER_NAME = "sdlc";

const claudeConfig = (): string => join(homedir(), ".claude.json");
const codexConfig = (): string => join(homedir(), ".codex", "config.toml");

async function version(bin: string): Promise<string | null> {
  try {
    const command = platformCommand(bin, ["--version"]);
    const { stdout } = await run(command.command, command.args, {
      timeout: 5000,
      env: spawnEnv(),
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

// --- detection -------------------------------------------------------------

async function claudeConnected(): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(claudeConfig(), "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(config.mcpServers?.[SERVER_NAME]);
  } catch {
    return false;
  }
}

async function codexConnected(): Promise<boolean> {
  try {
    const toml = await readFile(codexConfig(), "utf-8");
    // TOML permits whitespace around and inside the header.
    return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${SERVER_NAME}\\s*\\]`, "m").test(toml);
  } catch {
    return false;
  }
}

export async function detectHarnesses(): Promise<DetectedHarness[]> {
  const env = spawnEnv();
  const [claudeBin, codexBin] = await Promise.all([
    which("claude", env),
    which("codex", env),
  ]);

  const [claudeVersion, codexVersion, claudeOn, codexOn] = await Promise.all([
    claudeBin ? version(claudeBin) : Promise.resolve(null),
    codexBin ? version(codexBin) : Promise.resolve(null),
    claudeConnected(),
    codexConnected(),
  ]);

  return [
    {
      id: "claude-code",
      name: "Claude Code",
      binPath: claudeBin,
      version: claudeVersion,
      configPath: claudeConfig(),
      connected: claudeOn,
    },
    {
      id: "codex",
      name: "Codex",
      binPath: codexBin,
      version: codexVersion,
      configPath: codexConfig(),
      connected: codexOn,
    },
  ];
}

// --- connecting ------------------------------------------------------------

export interface BridgeCommand {
  command: string;
  args: string[];
  /**
   * Set when the command is an Electron binary being used as node. The
   * harness spawns the bridge itself, so it needs the variable too.
   */
  env?: Record<string, string>;
}

/**
 * Claude Code owns the format of ~/.claude.json, so the change goes through
 * its own CLI rather than a hand-edit of a 100 KB config file.
 */
async function connectClaude(bridge: BridgeCommand): Promise<void> {
  const env = Object.entries(bridge.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

  // The absolute path detection found — a bare "claude" fails from a
  // GUI-launched daemon whose PATH never had it.
  const bin = (await which("claude", spawnEnv())) ?? "claude";

  // Argument order matters: `-e` is variadic, so it eats every following
  // non-flag token. The server name has to be behind it, and `--` has to
  // close it, or the name is parsed as another environment variable.
  const command = platformCommand(bin, [
    "mcp",
    "add",
    SERVER_NAME,
    "--scope",
    "user",
    ...env,
    "--",
    bridge.command,
    ...bridge.args,
  ]);
  await run(command.command, command.args, {
    env: spawnEnv(),
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
}

async function disconnectClaude(): Promise<void> {
  const bin = (await which("claude", spawnEnv())) ?? "claude";
  const command = platformCommand(bin, ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  await run(command.command, command.args, {
    env: spawnEnv(),
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Replace or append exactly one [mcp_servers.sdlc] block, leaving the rest of
 * the user's config untouched. A .bak copy is taken before every write.
 */
function spliceCodexBlock(toml: string, block: string | null): string {
  // Whitespace-tolerant: `  [ mcp_servers.sdlc ]` is legal TOML, and missing
  // it here appends a duplicate table Codex then rejects wholesale.
  const header = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${SERVER_NAME}\\s*(\\.[^\\]]+)?\\]`,
    "m",
  );
  const lines = toml.split("\n");
  const kept: string[] = [];

  let skipping = false;
  for (const line of lines) {
    const isSectionHeader = /^\s*\[/.test(line);
    if (isSectionHeader) skipping = header.test(line);
    if (!skipping) kept.push(line);
  }

  let result = kept.join("\n").replace(/\n{3,}$/, "\n");
  if (block) {
    if (!result.endsWith("\n")) result += "\n";
    result += `\n${block}`;
  }
  return result;
}

async function writeCodex(block: string | null): Promise<void> {
  const path = codexConfig();
  await mkdir(dirname(path), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
    // Create-if-absent: the backup's value is being the user's *pristine*
    // config. Overwriting it on every write means that after
    // connect-then-disconnect the only backup contains our own edits.
    await copyFile(path, `${path}.sdlc-backup`, fsConstants.COPYFILE_EXCL).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  } catch {
    // No config yet — creating one is fine.
  }

  await writeFile(path, spliceCodexBlock(existing, block), "utf-8");
}

async function connectCodex(bridge: BridgeCommand): Promise<void> {
  const args = bridge.args.map(tomlString).join(", ");
  let block =
    `[mcp_servers.${SERVER_NAME}]\n` +
    `command = ${tomlString(bridge.command)}\n` +
    `args = [${args}]\n`;

  const env = Object.entries(bridge.env ?? {});
  if (env.length > 0) {
    block += `\n[mcp_servers.${SERVER_NAME}.env]\n`;
    for (const [key, value] of env) block += `${key} = ${tomlString(value)}\n`;
  }

  await writeCodex(block);
}

async function disconnectCodex(): Promise<void> {
  await writeCodex(null);
}

export async function connectHarness(id: string, bridge: BridgeCommand): Promise<void> {
  if (id === "claude-code") return connectClaude(bridge);
  if (id === "codex") return connectCodex(bridge);
  throw new Error(`Unknown harness "${id}".`);
}

export async function disconnectHarness(id: string): Promise<void> {
  if (id === "claude-code") return disconnectClaude();
  if (id === "codex") return disconnectCodex();
  throw new Error(`Unknown harness "${id}".`);
}

export { spliceCodexBlock };

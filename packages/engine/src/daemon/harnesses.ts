/**
 * Finding the coding CLIs on this machine, and wiring them to the engine.
 *
 * Both harnesses get the stdio bridge rather than an HTTP URL: the bridge
 * reads the daemon's port at spawn time, so a restart on a different port
 * does not leave stale config behind.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
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
const DETECTION_TTL_MS = 5 * 60_000;
let detectionCache: { expiresAt: number; harnesses: DetectedHarness[] } | null = null;
const tomlExactKey = (key: string): string => `(?:${key}|"${key}"|'${key}')`;
const CODEX_SERVER_HEADER = new RegExp(
  `^\\s*\\[\\s*${tomlExactKey("mcp_servers")}\\s*\\.\\s*` +
    `${tomlExactKey(SERVER_NAME)}(?:\\s*\\.[^\\]]+)?\\s*\\]`,
  "m",
);
const CODEX_SERVER_DOTTED_KEY = new RegExp(
  `^\\s*${tomlExactKey("mcp_servers")}\\s*\\.\\s*${tomlExactKey(SERVER_NAME)}` +
    `(?:\\s*\\.\\s*(?:[A-Za-z0-9_-]+|"(?:\\\\.|[^"\\\\])*"|'[^']*'))*\\s*=`,
);

export function hasCodexServer(toml: string): boolean {
  return (
    CODEX_SERVER_HEADER.test(toml) ||
    toml.split("\n").some((line) => CODEX_SERVER_DOTTED_KEY.test(line))
  );
}

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
    return hasCodexServer(toml);
  } catch {
    return false;
  }
}

export async function detectHarnesses(refresh = false): Promise<DetectedHarness[]> {
  if (!refresh && detectionCache && detectionCache.expiresAt > Date.now()) {
    return detectionCache.harnesses;
  }
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

  const harnesses: DetectedHarness[] = [
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
  detectionCache = { expiresAt: Date.now() + DETECTION_TTL_MS, harnesses };
  return harnesses;
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
  const bin = await which("claude", spawnEnv());
  if (!bin) {
    await removeClaudeServerFile(claudeConfig());
    return;
  }
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
  // Whitespace and quote tolerant: `[mcp_servers."sdlc"]` names the same
  // table as `[mcp_servers.sdlc]`; retaining both invalidates the whole file.
  const lines = toml.split("\n");
  const kept: string[] = [];

  let skipping = false;
  let skippingDottedValue: string | null = null;
  for (const line of lines) {
    const isSectionHeader = /^\s*\[/.test(line);
    if (isSectionHeader) skipping = CODEX_SERVER_HEADER.test(line);
    if (skipping) continue;

    // A table can be written entirely with dotted assignments instead of a
    // section header. Retaining those and appending [mcp_servers.sdlc] makes
    // the complete config invalid TOML because the same table is declared
    // twice. Continuation lines belong to the assignment until brackets,
    // braces and quotes balance again.
    if (skippingDottedValue === null && CODEX_SERVER_DOTTED_KEY.test(line)) {
      const value = line.slice(line.indexOf("=") + 1);
      skippingDottedValue = tomlValueComplete(value) ? null : value;
      continue;
    }
    if (skippingDottedValue !== null) {
      skippingDottedValue += `\n${line}`;
      if (tomlValueComplete(skippingDottedValue)) skippingDottedValue = null;
      continue;
    }
    kept.push(line);
  }

  let result = kept.join("\n").replace(/\n{3,}$/, "\n");
  if (block) {
    if (!result.endsWith("\n")) result += "\n";
    result += `\n${block}`;
  }
  return result;
}

/** Whether a TOML value has closed every quote, array and inline table. */
function tomlValueComplete(value: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (const char of value) {
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (quote) continue;
    // TOML comments end the value. Delimiters inside them are prose, not
    // continuation syntax (`args = [] # [legacy` is already complete).
    if (char === "#") break;
    if (char === "[") square++;
    else if (char === "]") square--;
    else if (char === "{") curly++;
    else if (char === "}") curly--;
  }
  return quote === null && square <= 0 && curly <= 0;
}

export async function writeCodexFile(path: string, block: string | null): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const existing = await readCodexForWrite(path);
  await atomicConfigWrite(path, spliceCodexBlock(existing, block));
}

async function atomicConfigWrite(path: string, content: string): Promise<void> {
  // Renaming over a symlink replaces the link itself. Dotfile managers commonly
  // make the harness config a symlink, so publish beside the final target and
  // leave the user's link intact. A dangling link is rejected by realpath
  // rather than silently being replaced with a regular file.
  let existing;
  try {
    existing = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") existing = null;
    else throw error;
  }
  let destination = path;
  if (existing?.isSymbolicLink()) {
    // Deliberately outside the lstat ENOENT handler: a dangling link must fail
    // closed, not fall back to a rename that destroys the link.
    destination = await realpath(path);
  } else if (existing && !existing.isFile()) {
    throw new Error(`Cannot update harness config: ${path} is not a regular file.`);
  }

  const temporary = `${destination}.sdlc-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Remove a stale Claude MCP entry when the CLI itself is no longer installed. */
export async function removeClaudeServerFile(path: string): Promise<void> {
  let existing: string;
  try {
    existing = await readConfigForWrite(path, "Claude");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
  if (!parsed.mcpServers || !Object.prototype.hasOwnProperty.call(parsed.mcpServers, SERVER_NAME)) {
    return;
  }
  delete parsed.mcpServers[SERVER_NAME];

  const indent = existing.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  const newline = existing.endsWith("\n") ? "\n" : "";
  await atomicConfigWrite(path, `${JSON.stringify(parsed, null, indent)}${newline}`);
}

async function writeCodex(block: string | null): Promise<void> {
  await writeCodexFile(codexConfig(), block);
}

/** Read a Codex config and guarantee its pristine backup before mutation. */
export async function readCodexForWrite(path: string): Promise<string> {
  return readConfigForWrite(path, "Codex", true);
}

async function readConfigForWrite(
  path: string,
  product: string,
  missingIsEmpty = false,
): Promise<string> {
  let existing: string;
  try {
    existing = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingIsEmpty) return "";
    throw error;
  }

  // Create-if-absent: the backup's value is being the user's *pristine*
  // config. Overwriting it on every write means that after
  // connect-then-disconnect the only backup contains our own edits.
  try {
    await copyFile(path, `${path}.sdlc-backup`, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const backup = await lstat(`${path}.sdlc-backup`);
    if (!backup.isFile()) {
      throw new Error(
        `Cannot preserve ${product} config: ${path}.sdlc-backup is not a regular file.`,
      );
    }
  }
  return existing;
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

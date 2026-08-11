/**
 * The Codex splice edits a config file the user owns and did not hand to us,
 * so it is tested against the shapes a real one takes: other MCP servers,
 * nested sub-tables, and our own block already being present.
 */

import { lstat, mkdir, readFile, readlink, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasCodexServer,
  readCodexForWrite,
  removeClaudeServerFile,
  spliceCodexBlock,
  writeCodexFile,
} from "../daemon/harnesses.js";
import {
  codexMcpOverride,
  drawInvocationArgs,
  MAP_MCP_TOOLS,
  mapCompletionAdvanced,
  mapRunSucceeded,
  supportedHarnesses,
} from "../daemon/draw.js";
import { posixShellQuote, windowsLauncherCommand } from "../daemon/launcher.js";
import { exec, platformCommand, processTreeTerminationCommand, spawnEnv } from "../lib/exec.js";
import { reviewInvocationArgs, runClaude } from "../review/agent.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

const OURS = `[mcp_servers.sdlc]\ncommand = "node"\nargs = ["/path/bridge.js"]\n`;

const EXISTING = `personality = "pragmatic"
model = "gpt-5.6-sol"

[plugins."github@openai-curated"]
enabled = true

[mcp_servers.node_repl]
command = "node"
args = ["repl.js"]

[mcp_servers.node_repl.env]
DEBUG = "1"

[mcp_servers.obsidian]
url = "http://localhost:1234"

[mcp_servers.obsidian.tools.vault_read]
enabled = true
`;

describe("codex config splice", () => {
  it("refuses to mutate a config when its pristine backup cannot be created", async () => {
    root = await makeProject({ "config.toml": EXISTING });
    const path = join(root, "config.toml");
    await mkdir(`${path}.sdlc-backup`);

    await expect(readCodexForWrite(path)).rejects.toThrow();
  });

  it("appends without disturbing anything already there", () => {
    const result = spliceCodexBlock(EXISTING, OURS);

    expect(result).toContain('personality = "pragmatic"');
    expect(result).toContain('[plugins."github@openai-curated"]');
    expect(result).toContain("[mcp_servers.node_repl]");
    expect(result).toContain("[mcp_servers.node_repl.env]");
    expect(result).toContain("[mcp_servers.obsidian]");
    expect(result).toContain("[mcp_servers.obsidian.tools.vault_read]");
    expect(result).toContain("[mcp_servers.sdlc]");
  });

  it("replaces our block instead of adding a second one", () => {
    const once = spliceCodexBlock(EXISTING, OURS);
    const twice = spliceCodexBlock(once, OURS.replace("/path/bridge.js", "/new/bridge.js"));

    expect(twice.match(/^\[mcp_servers\.sdlc\]$/gm)).toHaveLength(1);
    expect(twice).toContain("/new/bridge.js");
    expect(twice).not.toContain("/path/bridge.js");
  });

  it("removes our block and its sub-tables on disconnect", () => {
    const withEnv = spliceCodexBlock(
      EXISTING,
      `${OURS}\n[mcp_servers.sdlc.env]\nELECTRON_RUN_AS_NODE = "1"\n`,
    );
    expect(withEnv).toContain("[mcp_servers.sdlc.env]");

    const removed = spliceCodexBlock(withEnv, null);
    expect(removed).not.toContain("mcp_servers.sdlc");
    expect(removed).toContain("[mcp_servers.node_repl]");
    expect(removed).toContain("[mcp_servers.obsidian]");
  });

  it("does not touch a server whose name merely starts with ours", () => {
    const neighbour = `${EXISTING}\n[mcp_servers.sdlcx]\ncommand = "other"\n`;
    const removed = spliceCodexBlock(neighbour, null);
    expect(removed).toContain("[mcp_servers.sdlcx]");
  });

  it("creates a usable file when there is no config yet", () => {
    const result = spliceCodexBlock("", OURS);
    expect(result.trim()).toBe(OURS.trim());
  });

  it("replaces equivalent quoted table keys without creating invalid TOML", () => {
    const quoted = `${EXISTING}\n[mcp_servers."sdlc"]\ncommand = "old"\n\n[mcp_servers.'sdlc'.env]\nOLD = "1"\n`;
    const result = spliceCodexBlock(quoted, OURS);

    expect(result).not.toContain('mcp_servers."sdlc"');
    expect(result).not.toContain("mcp_servers.'sdlc'");
    expect(result.match(/^\[mcp_servers\.sdlc\]$/gm)).toHaveLength(1);
    expect(result).not.toContain('command = "old"');
  });

  it("replaces dotted server assignments, including multiline values", () => {
    const dotted = `${EXISTING}
mcp_servers.sdlc.command = "echo"
mcp_servers.sdlc.args = [
  "old",
  "--stdio",
]
mcp_servers.sdlc.env.ELECTRON_RUN_AS_NODE = "1"
`;
    const result = spliceCodexBlock(dotted, OURS);

    expect(result).not.toContain("mcp_servers.sdlc.command");
    expect(result).not.toContain("mcp_servers.sdlc.args");
    expect(result).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(result).not.toContain('  "old"');
    expect(result.match(/^\[mcp_servers\.sdlc\]$/gm)).toHaveLength(1);
  });

  it("does not consume unrelated config after delimiters in TOML comments", () => {
    const dotted = `${EXISTING}
mcp_servers.sdlc.args = [] # [legacy value

[profiles.careful]
model = "gpt-5.6-sol"
`;
    const result = spliceCodexBlock(dotted, OURS);

    expect(result).not.toContain("mcp_servers.sdlc.args");
    expect(result).toContain("[profiles.careful]");
    expect(result).toContain('model = "gpt-5.6-sol"');
  });

  it("expands a root inline MCP table before replacing SDLC", () => {
    const inline = `model = "gpt-5.6-sol"
mcp_servers = { other = { command = "other" }, sdlc = { command = "old", args = [] } }
`;

    expect(hasCodexServer(inline)).toBe(true);
    const result = spliceCodexBlock(inline, OURS);

    expect(result).toContain("[mcp_servers]");
    expect(result).toContain('other = { command = "other" }');
    expect(result).not.toContain("mcp_servers = {");
    expect(result).not.toContain('command = "old"');
    expect(result.match(/^\[mcp_servers\.sdlc\]$/gm)).toHaveLength(1);

    const removed = spliceCodexBlock(result, null);
    expect(removed).toContain('other = { command = "other" }');
    expect(removed).not.toContain("mcp_servers.sdlc");
  });

  it("removes multiline and parent-relative inline SDLC entries", () => {
    const rootInline = `mcp_servers = {
  other = { command = "other", args = ["one", "two"] },
  "sdlc" = { command = "old", args = [] },
}
`;
    const expanded = spliceCodexBlock(rootInline, OURS);
    expect(expanded).toContain('other = { command = "other", args = ["one", "two"] }');
    expect(expanded).not.toContain('"sdlc" =');
    expect(expanded.match(/^\[mcp_servers\.sdlc\]$/gm)).toHaveLength(1);

    const relative = `[mcp_servers]
other = { command = "other" }
sdlc = {
  command = "old"
}
`;
    expect(hasCodexServer(relative)).toBe(true);
    const replaced = spliceCodexBlock(relative, OURS);
    expect(replaced).toContain('other = { command = "other" }');
    expect(replaced).not.toContain('command = "old"');
    expect(replaced.match(/^\[mcp_servers\.sdlc\]$/gm)).toHaveLength(1);
  });

  it("publishes config updates atomically and keeps the pristine backup", async () => {
    root = await makeProject({ "config.toml": EXISTING });
    const path = join(root, "config.toml");

    await writeCodexFile(path, OURS);

    expect(await readFile(path, "utf-8")).toContain("[mcp_servers.sdlc]");
    expect(await readFile(`${path}.sdlc-backup`, "utf-8")).toBe(EXISTING);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("updates a symlink target without replacing the managed config link", async () => {
    root = await makeProject({ "managed.toml": EXISTING });
    const path = join(root, "config.toml");
    await symlink("managed.toml", path);

    await writeCodexFile(path, OURS);

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe("managed.toml");
    expect(await readFile(join(root, "managed.toml"), "utf-8")).toContain(
      "[mcp_servers.sdlc]",
    );
    expect(await readFile(`${path}.sdlc-backup`, "utf-8")).toBe(EXISTING);
  });

  it("rejects a dangling config symlink without replacing it", async () => {
    root = await makeProject({});
    const path = join(root, "config.toml");
    await symlink("missing.toml", path);

    await expect(writeCodexFile(path, OURS)).rejects.toThrow();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe("missing.toml");
  });

  it("detects bare and quoted forms of both dotted keys", () => {
    for (const header of [
      "[mcp_servers.sdlc]",
      "[mcp_servers.\"sdlc\"]",
      "[\"mcp_servers\".sdlc]",
      "['mcp_servers'.'sdlc']",
    ]) {
      expect(hasCodexServer(`${header}\ncommand = "node"\n`)).toBe(true);
    }
    expect(hasCodexServer('mcp_servers.sdlc.command = "node"')).toBe(true);
    expect(hasCodexServer('"mcp_servers"."sdlc".command = "node"')).toBe(true);
    expect(hasCodexServer("[mcp_servers.sdlcx]")).toBe(false);
    expect(hasCodexServer('mcp_servers.sdlcx.command = "node"')).toBe(false);
  });
});

describe("stale Claude connection cleanup", () => {
  it("removes only the SDLC server without requiring the missing CLI", async () => {
    const original = JSON.stringify(
      {
        theme: "dark",
        mcpServers: {
          other: { command: "other" },
          sdlc: { command: "old-sdlc" },
        },
      },
      null,
      4,
    );
    root = await makeProject({ ".claude.json": original });
    const path = join(root, ".claude.json");

    await removeClaudeServerFile(path);

    const result = JSON.parse(await readFile(path, "utf-8")) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(result.theme).toBe("dark");
    expect(result.mcpServers.other).toBeDefined();
    expect(result.mcpServers.sdlc).toBeUndefined();
    expect(await readFile(`${path}.sdlc-backup`, "utf-8")).toBe(original);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("GUI subprocess environment", () => {
  it("finds native Claude installs when launched outside a login shell", () => {
    const env = spawnEnv("darwin", { PATH: "/usr/bin:/bin", KEEP: "yes" }, "/Users/example");
    expect(env.PATH?.split(":")).toContain("/Users/example/.local/bin");
    expect(env.PATH?.split(":")).toContain("/opt/homebrew/bin");
    expect(env.KEEP).toBe("yes");
  });
});

describe("draw harness ids", () => {
  it("uses the same Claude id returned by harness detection", () => {
    expect(supportedHarnesses()).toContain("claude-code");
    expect(supportedHarnesses()).not.toContain("claude");
  });

  it("requires this drawing to advance the finalization marker", () => {
    expect(mapCompletionAdvanced(null, null)).toBe(false);
    expect(mapCompletionAdvanced("old", "old")).toBe(false);
    expect(mapCompletionAdvanced(null, "first")).toBe(true);
    expect(mapCompletionAdvanced("old", "new")).toBe(true);
  });

  it("accepts clean maintenance without requiring a new finalization marker", () => {
    expect(
      mapRunSucceeded(
        { marker: "existing", complete: true, clean: false },
        { marker: "existing", complete: true, clean: true },
      ),
    ).toBe(true);
    expect(
      mapRunSucceeded(
        { marker: "existing", complete: true, clean: false },
        { marker: "existing", complete: true, clean: false },
      ),
    ).toBe(false);
    expect(
      mapRunSucceeded(
        { marker: null, complete: false, clean: false },
        { marker: "first", complete: true, clean: true },
      ),
    ).toBe(true);
  });

  it("limits unattended Claude and Codex runs to map tools", () => {
    const claude = drawInvocationArgs("claude-code", "draw", {
      command: "/app/sdlc-bridge",
      args: ["--stdio"],
      env: { SDLC_PROJECT_ROOT: "/repo" },
    });
    const codex = drawInvocationArgs("codex", "draw", {
      command: "/app/sdlc-bridge",
      args: ["--stdio"],
      env: { SDLC_PROJECT_ROOT: "/repo" },
    });

    for (const tool of MAP_MCP_TOOLS) {
      expect(claude).toContain(`mcp__sdlc__${tool}`);
    }
    expect(claude).not.toContain("mcp__sdlc");
    expect(claude).not.toContain("mcp__sdlc__audit_run_tools");
    expect(claude.slice(claude.indexOf("--tools"), claude.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(claude).not.toContain("Read");
    expect(claude).not.toContain("Grep");
    expect(claude).not.toContain("Glob");
    expect(claude).toContain("--strict-mcp-config");
    expect(claude).toContain("user");
    const config = JSON.parse(claude[claude.indexOf("--mcp-config") + 1]!) as {
      mcpServers: { sdlc: { command: string; alwaysLoad: boolean } };
    };
    expect(config.mcpServers.sdlc.command).toBe("/app/sdlc-bridge");
    expect(config.mcpServers.sdlc.alwaysLoad).toBe(true);
    const override = codex.find((value) => value.startsWith("mcp_servers ="))!;
    expect(override).toBe(
      codexMcpOverride({
        command: "/app/sdlc-bridge",
        args: ["--stdio"],
        env: { SDLC_PROJECT_ROOT: "/repo" },
      }),
    );
    expect(override).toContain("mcp_servers = { sdlc = {");
    expect(override).toContain('command = "/app/sdlc-bridge"');
    expect(override).not.toContain("mcp_servers.sdlc");
    expect(codex).toContain("--ignore-user-config");
    expect(codex).toContain("--ignore-rules");
    expect(codex).toContain("--ephemeral");
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "multi_agent",
      "apps",
      "plugins",
      "browser_use",
      "in_app_browser",
    ]) {
      const disabledAt = codex.findIndex(
        (value, index) => value === feature && codex[index - 1] === "--disable",
      );
      expect(disabledAt).toBeGreaterThan(0);
    }
    expect(codex).toContain("tools.web_search=false");
    expect(codex).toContain("tools.view_image=false");
    expect(codex.join(" ")).not.toContain("audit_run_tools");
  });

  it("gives headless review no tools or inherited project settings", () => {
    const args = reviewInvocationArgs();
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2))
      .toEqual(["--setting-sources", "user"]);
  });

  it("does not start a paid review after its request was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runClaude("do not run", {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Cancelled.");
  });
});

describe("Windows bridge launcher", () => {
  it("runs the generated batch file through cmd.exe", () => {
    expect(windowsLauncherCommand("C:\\SDLC Data\\sdlc-bridge.cmd", "C:\\Windows\\cmd.exe"))
      .toEqual({
        command: "C:\\Windows\\cmd.exe",
        args: ["/d", "/s", "/c", "C:\\SDLC Data\\sdlc-bridge.cmd"],
      });
  });

  it("routes npm CLI shims and bare commands through cmd.exe", () => {
    const shim = platformCommand("C:\\Tools\\claude.cmd", ["--version"], "win32", "cmd.exe");
    expect(shim.command).toBe("cmd.exe");
    expect(shim.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(shim.args[4]).toContain("claude.cmd");
    expect(shim.windowsVerbatimArguments).toBe(true);
    expect(platformCommand("claude", ["-p"], "win32", "cmd.exe").command).toBe("cmd.exe");
    expect(platformCommand("C:\\Tools\\codex.exe", ["exec"], "win32", "cmd.exe").command)
      .toBe("C:\\Tools\\codex.exe");
  });

  it("escapes shell metacharacters before cmd.exe sees model-controlled arguments", () => {
    const command = platformCommand(
      "claude",
      ["--model", "trusted & calc.exe | more"],
      "win32",
      "cmd.exe",
    );
    const line = command.args.at(-1)!;
    expect(line).toMatch(/\^+&/);
    expect(line).toMatch(/\^+\|/);
    expect(line).not.toMatch(/(^|[^\^])&/);
    expect(line).not.toMatch(/(^|[^\^])\|/);
    expect(command.windowsVerbatimArguments).toBe(true);
  });

  it("terminates the wrapper and its full descendant tree", () => {
    expect(processTreeTerminationCommand(412, false, "win32")).toEqual({
      command: "taskkill.exe",
      args: ["/pid", "412", "/t"],
    });
    expect(processTreeTerminationCommand(412, true, "win32")?.args).toEqual([
      "/pid",
      "412",
      "/t",
      "/f",
    ]);
    expect(processTreeTerminationCommand(412, true, "darwin")).toBeNull();
  });
});

describe("subprocess output bounds", () => {
  it("reports max-buffer truncation distinctly from spawn and timeout failures", async () => {
    const result = await exec(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000))"], {
      maxBuffer: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.spawnFailed).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("rejects cancellation and stops a long-running child promptly", async () => {
    const controller = new AbortController();
    const running = exec(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { signal: controller.signal, timeout: 10_000 },
    );
    setTimeout(() => controller.abort(new Error("cancelled by caller")), 25);

    await expect(running).rejects.toThrow(/cancelled by caller/);
  });

  it("reports a process-tree timeout distinctly", async () => {
    const result = await exec(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeout: 25 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.spawnFailed).toBe(false);
  });

  it("terminates a producer whose output artifact exceeds its disk bound", async () => {
    root = await makeProject({});
    const artifact = join(root, "growing.bin");
    const result = await exec(
      process.execPath,
      [
        "-e",
        "const fs=require('fs');const fd=fs.openSync(process.argv[1],'w');const chunk=Buffer.alloc(65536);setInterval(()=>fs.writeSync(fd,chunk),1)",
        artifact,
      ],
      { timeout: 10_000, maxFileSize: { path: artifact, bytes: 128 * 1024 } },
    );

    expect(result.fileSizeExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.spawnFailed).toBe(false);
  });

  it("classifies an oversized artifact even when its producer exits between polling ticks", async () => {
    root = await makeProject({});
    const artifact = join(root, "fast.bin");
    const result = await exec(
      process.execPath,
      [
        "-e",
        "require('fs').writeFileSync(process.argv[1], Buffer.alloc(1024 * 1024))",
        artifact,
      ],
      { timeout: 10_000, maxFileSize: { path: artifact, bytes: 128 * 1024 } },
    );

    expect(result.fileSizeExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.spawnFailed).toBe(false);
  });
});

describe("launcher quoting", () => {
  it("keeps POSIX expansion syntax literal in installation paths", () => {
    expect(posixShellQuote("/Applications/$HOME/`other`/SDLC")).toBe(
      "'/Applications/$HOME/`other`/SDLC'",
    );
    expect(posixShellQuote("/Applications/owner's SDLC")).toContain("'\"'\"'");
  });
});

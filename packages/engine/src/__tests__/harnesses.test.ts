/**
 * The Codex splice edits a config file the user owns and did not hand to us,
 * so it is tested against the shapes a real one takes: other MCP servers,
 * nested sub-tables, and our own block already being present.
 */

import { describe, expect, it } from "vitest";
import { spliceCodexBlock } from "../daemon/harnesses.js";
import {
  codexMcpOverride,
  drawInvocationArgs,
  MAP_MCP_TOOLS,
  supportedHarnesses,
} from "../daemon/draw.js";
import { posixShellQuote, windowsLauncherCommand } from "../daemon/launcher.js";
import { platformCommand, processTreeTerminationCommand } from "../lib/exec.js";
import { reviewInvocationArgs } from "../review/agent.js";

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
});

describe("draw harness ids", () => {
  it("uses the same Claude id returned by harness detection", () => {
    expect(supportedHarnesses()).toContain("claude-code");
    expect(supportedHarnesses()).not.toContain("claude");
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
      mcpServers: { sdlc: { command: string } };
    };
    expect(config.mcpServers.sdlc.command).toBe("/app/sdlc-bridge");
    const override = codex[codex.indexOf("-c") + 1]!;
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

describe("launcher quoting", () => {
  it("keeps POSIX expansion syntax literal in installation paths", () => {
    expect(posixShellQuote("/Applications/$HOME/`other`/SDLC")).toBe(
      "'/Applications/$HOME/`other`/SDLC'",
    );
    expect(posixShellQuote("/Applications/owner's SDLC")).toContain("'\"'\"'");
  });
});

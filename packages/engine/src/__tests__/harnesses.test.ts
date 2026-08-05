/**
 * The Codex splice edits a config file the user owns and did not hand to us,
 * so it is tested against the shapes a real one takes: other MCP servers,
 * nested sub-tables, and our own block already being present.
 */

import { describe, expect, it } from "vitest";
import { spliceCodexBlock } from "../daemon/harnesses.js";

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

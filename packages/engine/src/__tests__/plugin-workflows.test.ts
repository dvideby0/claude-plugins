import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

async function command(name: string): Promise<string> {
  return readFile(join(repositoryRoot, "plugins", "sdlc", "commands", `${name}.md`), "utf-8");
}

describe("companion command contracts", () => {
  it("completes new maps before using the incremental drift path", async () => {
    const map = await command("map");

    expect(map).toContain("mcp__sdlc__finalize_map");
    expect(map).toContain("**`complete: false`**");
    expect(map).toContain("call `finalize_map`");
  });

  it("allows the memory mutations its workflows require", async () => {
    expect(await command("audit")).toContain("mcp__sdlc__remember");
    expect(await command("brainstorm")).toContain("mcp__sdlc__forget");
  });
});

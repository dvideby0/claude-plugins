import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runGitAnalysis } from "../../scripts/git-analysis.js";
import type { GitHotspot } from "../../lib/types.js";

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function git(dir: string, ...args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

describe("runGitAnalysis", () => {
  it("produces hotspots and bus factor for a git repo with commits", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "git-test-"));

    // Set up a git repo with known commits
    git(tmpDir, "init", "-q");
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test User");

    execFileSync("mkdir", ["-p", join(tmpDir, "src")]);
    execFileSync("bash", ["-c", `echo "v1" > "${join(tmpDir, "src", "hot_file.py")}"`]);
    execFileSync("bash", ["-c", `echo "v1" > "${join(tmpDir, "src", "cold_file.py")}"`]);
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-q", "-m", "initial", "--date=2025-01-01T00:00:00");

    // Modify hot_file multiple times
    for (let i = 2; i <= 5; i++) {
      execFileSync("bash", ["-c", `echo "v${i}" > "${join(tmpDir, "src", "hot_file.py")}"`]);
      git(tmpDir, "add", ".");
      git(tmpDir, "commit", "-q", "-m", `change ${i}`, `--date=2025-12-0${i}T00:00:00`);
    }

    const result = await runGitAnalysis(tmpDir);

    expect(result.hotspotsWritten).toBe(true);
    expect(result.busfactorWritten).toBe(true);

    // Verify hotspots file
    const hotspotsPath = join(tmpDir, "sdlc-audit", "data", "git-hotspots.txt");
    const hotspotsRaw = await readFile(hotspotsPath, "utf-8");
    const hotspots = JSON.parse(hotspotsRaw) as { hotspots: GitHotspot[] };

    expect(hotspots.hotspots).toBeDefined();
    expect(hotspots.hotspots.length).toBeGreaterThan(0);

    // hot_file.py should have more changes than cold_file.py
    const hotEntry = hotspots.hotspots.find((h) => h.file.includes("hot_file"));
    const coldEntry = hotspots.hotspots.find((h) => h.file.includes("cold_file"));
    expect(hotEntry).toBeDefined();
    expect(hotEntry!.changes).toBeGreaterThan(coldEntry?.changes ?? 0);

    // Verify bus factor file
    const busfactorPath = join(tmpDir, "sdlc-audit", "data", "git-busfactor.txt");
    const busfactorContent = await readFile(busfactorPath, "utf-8");
    expect(busfactorContent).toContain("BUS FACTOR");
    expect(busfactorContent).toContain("Total commits");
    expect(busfactorContent).toContain("Test User");
  });

  it("returns gracefully for non-git directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "git-test-nongit-"));

    const result = await runGitAnalysis(tmpDir);

    expect(result.hotspotsWritten).toBe(false);
    expect(result.busfactorWritten).toBe(false);
  });

  it("handles empty git repo with no commits", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "git-test-empty-"));

    git(tmpDir, "init", "-q");

    const result = await runGitAnalysis(tmpDir);

    // Should still succeed — files may be created with empty/minimal content
    // The important thing is it doesn't throw
    expect(result.hotspotsWritten).toBe(true);
  });

  it("produces hotspots with correct structure", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "git-test-struct-"));

    git(tmpDir, "init", "-q");
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test");

    execFileSync("bash", ["-c", `echo "a" > "${join(tmpDir, "file.txt")}"`]);
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-q", "-m", "first");

    execFileSync("bash", ["-c", `echo "b" > "${join(tmpDir, "file.txt")}"`]);
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-q", "-m", "second");

    await runGitAnalysis(tmpDir);

    const hotspotsPath = join(tmpDir, "sdlc-audit", "data", "git-hotspots.txt");
    const hotspots = JSON.parse(await readFile(hotspotsPath, "utf-8"));

    for (const entry of hotspots.hotspots) {
      expect(typeof entry.changes).toBe("number");
      expect(typeof entry.file).toBe("string");
      expect(entry.changes).toBeGreaterThan(0);
    }
  });
});

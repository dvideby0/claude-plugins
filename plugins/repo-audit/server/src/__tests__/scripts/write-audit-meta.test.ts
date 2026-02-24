import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { writeAuditMeta } from "../../scripts/write-audit-meta.js";
import type { AuditMeta } from "../../lib/types.js";

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("writeAuditMeta", () => {
  it("writes valid JSON with all required fields", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-"));

    const meta = await writeAuditMeta({
      projectRoot: tmpDir,
      auditType: "full",
      modules: ["src_auth", "src_utils", "src_api"],
    });

    // Verify file was written
    const filePath = join(tmpDir, "sdlc-audit", "data", ".audit-meta.json");
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as AuditMeta;

    // All fields present
    expect(parsed).toHaveProperty("last_audit");
    expect(parsed).toHaveProperty("last_audit_type");
    expect(parsed).toHaveProperty("modules_analyzed");
    expect(parsed).toHaveProperty("total_modules");
    expect(parsed).toHaveProperty("git_sha");
    expect(parsed).toHaveProperty("plugin_version");
    expect(parsed).toHaveProperty("detection_hash");

    expect(parsed.last_audit_type).toBe("full");
    expect(parsed.modules_analyzed).toEqual(["src_auth", "src_utils", "src_api"]);
    expect(parsed.total_modules).toBe(3);

    // Return value matches file
    expect(meta).toEqual(parsed);
  });

  it("captures git SHA when in a git repo", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-git-"));

    execFileSync("git", ["init", "-q"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    execFileSync("bash", ["-c", `echo test > "${join(tmpDir, "file.txt")}"`]);
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: tmpDir });

    const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      encoding: "utf-8",
    }).trim();

    const meta = await writeAuditMeta({
      projectRoot: tmpDir,
      auditType: "incremental",
      modules: ["src_auth"],
    });

    expect(meta.git_sha).toBe(expectedSha);
    expect(meta.last_audit_type).toBe("incremental");
  });

  it("sets git_sha to null for non-git directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-nogit-"));

    const meta = await writeAuditMeta({ projectRoot: tmpDir });

    expect(meta.git_sha).toBeNull();
  });

  it("sets plugin_version to null when no plugin root", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-noplugin-"));

    const meta = await writeAuditMeta({ projectRoot: tmpDir });

    expect(meta.plugin_version).toBeNull();
  });

  it("reads plugin version from plugin.json", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-plugin-"));

    const pluginRoot = join(tmpDir, "mock-plugin");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "test", version: "3.1.4" }),
    );

    const meta = await writeAuditMeta({
      projectRoot: tmpDir,
      pluginRoot,
      modules: ["src_auth"],
    });

    expect(meta.plugin_version).toBe("3.1.4");
  });

  it("computes detection hash from detection.json", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-hash-"));
    const dataDir = join(tmpDir, "sdlc-audit", "data");
    await mkdir(dataDir, { recursive: true });

    await writeFile(
      join(dataDir, "detection.json"),
      JSON.stringify({
        all_directories: {
          "src/auth": { category: "source", languages: ["typescript"] },
          "src/api": { category: "source", languages: ["typescript"] },
        },
      }),
    );

    const meta = await writeAuditMeta({ projectRoot: tmpDir });

    // Should be a 64-char hex string (SHA-256)
    expect(meta.detection_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces deterministic detection hash", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-determ-"));
    const dataDir = join(tmpDir, "sdlc-audit", "data");
    await mkdir(dataDir, { recursive: true });

    const detection = {
      all_directories: {
        "src/api": { category: "source", languages: ["typescript"] },
        "src/auth": { category: "source", languages: ["typescript"] },
      },
    };

    await writeFile(join(dataDir, "detection.json"), JSON.stringify(detection));
    const meta1 = await writeAuditMeta({ projectRoot: tmpDir });

    // Delete and rewrite the meta file, run again
    await writeFile(join(dataDir, "detection.json"), JSON.stringify(detection));
    const meta2 = await writeAuditMeta({ projectRoot: tmpDir });

    expect(meta1.detection_hash).toBe(meta2.detection_hash);
  });

  it("produces valid ISO 8601 timestamp", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-ts-"));

    const meta = await writeAuditMeta({ projectRoot: tmpDir });

    expect(meta.last_audit).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("handles empty modules list", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-empty-"));

    const meta = await writeAuditMeta({ projectRoot: tmpDir });

    expect(meta.modules_analyzed).toEqual([]);
    expect(meta.total_modules).toBe(0);
  });

  it("defaults audit type to full", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "meta-test-default-"));

    const meta = await writeAuditMeta({ projectRoot: tmpDir });

    expect(meta.last_audit_type).toBe("full");
  });
});

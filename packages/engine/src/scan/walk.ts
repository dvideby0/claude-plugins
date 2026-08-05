/**
 * In-process directory walk: language classification, line counts and content
 * hashes. No external binaries.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

export type Lang = "typescript" | "javascript" | "python" | "config" | "docs" | "other";

export interface ScannedFile {
  path: string;
  lang: Lang;
  loc: number;
  bytes: number;
  contentSha: string;
  isTest: boolean;
  content: string;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  "coverage", "__pycache__", ".venv", "venv", "env", ".mypy_cache", ".ruff_cache",
  ".pytest_cache", ".tox", "target", "vendor", "site-packages", ".eggs", "htmlcov",
  ".idea", ".vscode", "sdlc-audit", ".turbo", ".cache", ".parcel-cache",
]);

const EXT_LANG: Record<string, Lang> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".py": "python", ".pyi": "python",
  ".json": "config", ".yml": "config", ".yaml": "config", ".toml": "config", ".ini": "config",
  ".md": "docs", ".rst": "docs",
};

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Files that are large, generated or lockfiles — indexed but never parsed. */
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Pipfile\.lock)$|\.min\.(js|css)$|\.bundle\.js$/;

export function classify(path: string): Lang {
  return EXT_LANG[extname(path).toLowerCase()] ?? "other";
}

export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.py$/.test(path) ||
    /(^|\/)conftest\.py$/.test(path)
  );
}

export function isNoise(path: string): boolean {
  return NOISE.test(path);
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Walk a project and return every indexable file.
 * `content` is retained so callers can parse without a second read.
 */
export async function walk(projectRoot: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = toPosix(relative(projectRoot, full));
      const lang = classify(rel);
      if (lang === "other") continue;

      let size: number;
      try {
        size = (await stat(full)).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = await readFile(full, "utf-8");
      } catch {
        continue;
      }
      if (content.indexOf(String.fromCharCode(0)) !== -1) continue; // binary

      files.push({
        path: rel,
        lang,
        loc: content.length === 0 ? 0 : content.split("\n").length,
        bytes: size,
        contentSha: createHash("sha256").update(content).digest("hex").slice(0, 16),
        isTest: isTestPath(rel),
        content,
      });
    }
  }

  await visit(projectRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

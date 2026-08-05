/**
 * Where the review guides and lenses live.
 *
 * These used to ship inside the plugin and arrive via PLUGIN_ROOT. They are
 * engine data now, so the engine finds them itself: next to the compiled
 * output in development, and in the app's resources once packaged.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function contentDir(): string {
  if (cached) return cached;

  const override = process.env.SDLC_CONTENT_DIR;
  if (override) {
    cached = override;
    return cached;
  }

  // dist/content.js -> package root; src/content.ts -> package root.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "content");
    if (existsSync(join(candidate, "lang", "general.md"))) {
      cached = candidate;
      return cached;
    }
    dir = dirname(dir);
  }

  throw new Error(
    "Engine content/ not found. Set SDLC_CONTENT_DIR to the directory holding lang/ and lenses/.",
  );
}

/** Read one file out of the content directory, by path relative to it. */
export async function readContent(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(join(contentDir(), relative), "utf-8");
}

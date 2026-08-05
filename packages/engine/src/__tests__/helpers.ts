import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetDbCache } from "../db/db.js";

export async function makeProject(
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sdlc-test-"));
  await writeFiles(root, files);
  return root;
}

export async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function cleanup(root: string): Promise<void> {
  await resetDbCache();
  await rm(root, { recursive: true, force: true });
}

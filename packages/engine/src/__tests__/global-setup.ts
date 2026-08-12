import { mkdir, rm } from "node:fs/promises";

export default async function setupTestState(): Promise<() => Promise<void>> {
  const state = process.env.SDLC_HOME;
  if (!state) throw new Error("Vitest must provide an isolated SDLC_HOME");
  await rm(state, { recursive: true, force: true });
  await mkdir(state, { recursive: true });
  return () => rm(state, { recursive: true, force: true });
}

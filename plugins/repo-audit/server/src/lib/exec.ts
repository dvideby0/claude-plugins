/**
 * Subprocess execution.
 *
 * Every failure mode is reported explicitly — a missing binary, a timeout and
 * a non-zero exit are three different outcomes and callers must be able to
 * tell them apart.
 */

import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null when the process was killed by a signal. */
  exitCode: number | null;
  /** True when the binary could not be spawned (not installed / not on PATH). */
  spawnFailed: boolean;
  /** True when the process was killed for exceeding its timeout. */
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            stdout,
            stderr,
            exitCode: 0,
            spawnFailed: false,
            timedOut: false,
          });
          return;
        }

        const err = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };

        // Spawn failures surface a string errno (ENOENT, EACCES, ...).
        const spawnFailed = typeof err.code === "string";
        // A timeout kill arrives as killed + signal with no numeric exit code.
        const timedOut = err.killed === true && err.signal != null;

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof err.code === "number" ? err.code : null,
          spawnFailed,
          timedOut,
        });
      },
    );
  });
}

/** Resolve a command on PATH. Returns its path, or null when absent. */
export async function which(command: string): Promise<string | null> {
  const result = await exec("which", [command], { timeout: 5_000 });
  if (result.spawnFailed || result.exitCode !== 0) return null;
  const path = result.stdout.trim().split("\n")[0];
  return path.length > 0 ? path : null;
}

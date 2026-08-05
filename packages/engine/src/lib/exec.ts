/**
 * Subprocess execution.
 *
 * Every failure mode is reported explicitly — a missing binary, a timeout and
 * a non-zero exit are three different outcomes and callers must be able to
 * tell them apart.
 */

import { execFile } from "node:child_process";
import { extname } from "node:path";

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
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface PlatformCommand {
  command: string;
  args: string[];
}

/**
 * Make a CLI invocation spawnable on every platform.
 *
 * npm-installed commands are `.cmd` shims on Windows. Node's execFile/spawn
 * APIs cannot execute those scripts directly, and callers often begin with a
 * bare command name that cmd.exe must resolve to the shim. Real `.exe` files
 * remain direct children so signals and exit codes keep their normal shape.
 */
export function platformCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
): PlatformCommand {
  const extension = extname(command).toLowerCase();
  const needsCmd =
    platform === "win32" && (extension === "" || extension === ".cmd" || extension === ".bat");
  return needsCmd
    ? { command: comspec, args: ["/d", "/s", "/c", command, ...args] }
    : { command, args };
}

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
        env: options.env,
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

        // Spawn failures surface a string errno (ENOENT, EACCES, ...) — but
        // so does a maxBuffer overflow, which comes from a process that ran
        // fine and simply said too much. Calling that "could not execute"
        // sends whoever reads the report to check a binary that works.
        const overflowed = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const spawnFailed = typeof err.code === "string" && !overflowed;
        // A timeout kill arrives as killed + signal with no numeric exit code.
        const timedOut = err.killed === true && err.signal != null && !overflowed;

        if (overflowed) {
          resolve({
            stdout: stdout ?? "",
            stderr: `output exceeded ${options.maxBuffer ?? DEFAULT_MAX_BUFFER} bytes`,
            exitCode: null,
            spawnFailed: false,
            timedOut: false,
          });
          return;
        }

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
export async function which(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = await exec(finder, [command], { timeout: 5_000, env });
  if (result.spawnFailed || result.exitCode !== 0) return null;
  const path = result.stdout.trim().split("\n")[0];
  return path.length > 0 ? path : null;
}

/**
 * The environment for spawning the user's own tools.
 *
 * The daemon inherits the desktop app's environment, and an app launched
 * from Finder or the Dock gets launchd's minimal PATH — no Homebrew, so no
 * `claude` and no `codex`, even though every terminal finds both. The
 * standard install locations are appended rather than trusted to be there.
 */
export function spawnEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "darwin") return process.env;
  const extras = ["/opt/homebrew/bin", "/usr/local/bin"];
  const parts = (process.env.PATH ?? "").split(":");
  const missing = extras.filter((dir) => !parts.includes(dir));
  if (missing.length === 0) return process.env;
  return { ...process.env, PATH: [...parts, ...missing].join(":") };
}

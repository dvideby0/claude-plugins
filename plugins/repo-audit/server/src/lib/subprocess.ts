import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export function runScript(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const env = { ...process.env, ...options.env };

    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout,
      },
      (error, stdout, stderr) => {
        if (error && !("code" in error)) {
          reject(error);
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: (error as NodeJS.ErrnoException & { code?: number })?.code
            ? typeof child.exitCode === "number"
              ? child.exitCode
              : 1
            : child.exitCode ?? 0,
        });
      },
    );
  });
}

export function runBashScript(
  scriptPath: string,
  args: string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return runScript("bash", [scriptPath, ...args], options);
}

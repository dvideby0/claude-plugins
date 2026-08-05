/**
 * Driving a coding CLI headlessly.
 *
 * The engine does not hold an API key. It shells out to whichever CLI the user
 * has already authenticated, which means review costs land on their existing
 * plan and there is no second set of credentials to store or leak.
 */

import { spawn } from "node:child_process";
import { platformCommand, spawnEnv } from "../lib/exec.js";

export interface AgentResult {
  ok: boolean;
  text: string;
  costUsd: number | null;
  durationMs: number;
  error: string | null;
}

export interface AgentOptions {
  cwd: string;
  /** Hard stop, so a stuck review cannot pin a core forever. */
  timeoutMs?: number;
  model?: string;
}

/** Exposed so the no-tools security boundary can be regression-tested. */
export function reviewInvocationArgs(options: Pick<AgentOptions, "model"> = {}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    // Review text is untrusted repository input. No tools means it cannot
    // turn a review prompt into filesystem/MCP side effects, and excluding
    // project/local settings keeps repository hooks out of the child.
    "--tools",
    "",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];
  if (options.model) args.push("--model", options.model);
  return args;
}

interface ClaudeEnvelope {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  subtype?: string;
}

/**
 * Run one prompt through `claude -p`.
 *
 * The prompt goes over stdin rather than argv: review prompts run to tens of
 * kilobytes and would otherwise risk the platform argument limit.
 */
export function runClaude(prompt: string, options: AgentOptions): Promise<AgentResult> {
  const started = Date.now();
  const args = reviewInvocationArgs(options);
  const command = platformCommand("claude", args);

  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Augmented PATH: from a Dock-launched app, launchd's PATH has no
      // Homebrew, and "could not run claude" would blame a working install.
      env: spawnEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: AgentResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        text: "",
        costUsd: null,
        durationMs: Date.now() - started,
        error: `Timed out after ${options.timeoutMs ?? 300_000}ms`,
      });
    }, options.timeoutMs ?? 300_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        text: "",
        costUsd: null,
        durationMs: Date.now() - started,
        error: `Could not run claude: ${error.message}`,
      });
    });

    child.on("close", () => {
      const durationMs = Date.now() - started;
      let envelope: ClaudeEnvelope;
      try {
        envelope = JSON.parse(stdout) as ClaudeEnvelope;
      } catch {
        finish({
          ok: false,
          text: stdout,
          costUsd: null,
          durationMs,
          error: stderr.trim() || "Could not parse the CLI response.",
        });
        return;
      }

      if (envelope.is_error) {
        finish({
          ok: false,
          text: envelope.result ?? "",
          costUsd: envelope.total_cost_usd ?? null,
          durationMs,
          // The CLI reports auth and quota failures in this field.
          error: envelope.result ?? "The CLI reported an error.",
        });
        return;
      }

      finish({
        ok: true,
        text: envelope.result ?? "",
        costUsd: envelope.total_cost_usd ?? null,
        durationMs,
        error: null,
      });
    });

    // A child that dies before draining stdin (timeout SIGKILL, bad auth,
    // missing binary) emits EPIPE here; without a handler that is an uncaught
    // exception in the daemon. The close handler reports the real failure.
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Balanced-bracket scan from one position; the parsed value or null. */
function parseBalanced(
  text: string,
  start: number,
  open: string,
  close: string,
): { value: unknown; length: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), length: i + 1 - start };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Pull the JSON array or object out of a model reply.
 *
 * Models fence code, add a sentence before it, or do both — and the prose
 * itself contains brackets ("[see notes]") and code snippets ("arr[0]") that
 * parse as JSON. So: any candidate that parses *whole* wins immediately;
 * otherwise every bracket position in every candidate is scanned and the
 * longest successful parse wins, because the payload is the big one and the
 * junk matches are two characters wide.
 */
export function extractJson<T>(text: string): T | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
  const candidates = [...fences, text].filter(
    (value): value is string => Boolean(value?.trim()),
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim()) as T;
    } catch {
      // Fall through to scanning.
    }
  }

  let best: { value: unknown; length: number } | null = null;
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    for (const [open, close] of [
      ["[", "]"],
      ["{", "}"],
    ] as const) {
      for (
        let start = trimmed.indexOf(open);
        start !== -1;
        start = trimmed.indexOf(open, start + 1)
      ) {
        const parsed = parseBalanced(trimmed, start, open, close);
        if (parsed && (!best || parsed.length > best.length)) best = parsed;
      }
    }
  }

  return (best?.value as T) ?? null;
}

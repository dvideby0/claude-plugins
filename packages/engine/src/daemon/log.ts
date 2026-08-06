/** Bounded, private daemon logging. */

import {
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface DaemonLog {
  write: (line: string) => void;
  close: () => void;
}

/**
 * Keep one bounded previous log and an owner-only current log.
 *
 * Synchronous writes are deliberate: daemon messages are infrequent, while a
 * simple descriptor makes rotation atomic with respect to every caller and
 * avoids buffering another unbounded queue during an error storm.
 */
export function openDaemonLog(
  path: string,
  maxBytes = DEFAULT_MAX_LOG_BYTES,
): DaemonLog {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }

  const previous = `${path}.1`;
  let descriptor = openSync(path, "a", 0o600);
  let bytes = fstatSync(descriptor).size;
  let available = true;

  const makePrivate = (target: string): void => {
    try {
      chmodSync(target, 0o600);
    } catch {
      // Windows does not implement POSIX modes. The state still lives under
      // the user's profile and the open call requested the restrictive mode.
    }
  };

  const reopen = (): void => {
    descriptor = openSync(path, "a", 0o600);
    makePrivate(path);
    bytes = fstatSync(descriptor).size;
  };

  const rotate = (): void => {
    closeSync(descriptor);
    rmSync(previous, { force: true });
    // Do not preserve a legacy runaway log as the backup. Normal rotation
    // reaches this point at roughly maxBytes and retains one useful history.
    if (bytes <= maxBytes * 2) renameSync(path, previous);
    else rmSync(path, { force: true });
    reopen();
  };

  makePrivate(path);
  if (bytes >= maxBytes) rotate();

  return {
    write(line): void {
      if (!available) return;
      const chunk = Buffer.from(line);
      try {
        if (bytes > 0 && bytes + chunk.length > maxBytes) rotate();
        writeSync(descriptor, chunk);
        bytes += chunk.length;
      } catch {
        // Logging must never become an uncaught-exception loop or take down the
        // indexing service because a disk filled or a volume disappeared.
        available = false;
        try {
          closeSync(descriptor);
        } catch {
          // The failed write may already have invalidated the descriptor.
        }
      }
    },
    close(): void {
      if (!available) return;
      available = false;
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort during process shutdown.
      }
    },
  };
}

interface ErrorAwareWriter {
  destroyed?: boolean;
  writableEnded?: boolean;
  on: (event: "error", listener: (error: Error) => void) => unknown;
  write: (chunk: string) => unknown;
}

/** A closed parent pipe must not recursively crash a long-lived daemon. */
export function safeStreamWriter(stream: ErrorAwareWriter): (line: string) => void {
  let available = true;
  stream.on("error", () => {
    available = false;
  });
  return (line: string): void => {
    if (!available || stream.destroyed || stream.writableEnded) return;
    try {
      stream.write(line);
    } catch {
      available = false;
    }
  };
}

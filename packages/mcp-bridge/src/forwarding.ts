/**
 * Long engine operations outlive the MCP SDK's one-minute default.
 *
 * A full review can legitimately run several five-minute model passes. Keep a
 * finite upper bound for a genuinely lost connection, while relying on the
 * harness cancellation signal for the normal user-controlled stop path.
 */
export const UPSTREAM_TOOL_TIMEOUT_MS = 6 * 60 * 60_000;

export function forwardingOptions(signal: AbortSignal): {
  signal: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
} {
  return {
    signal,
    timeout: UPSTREAM_TOOL_TIMEOUT_MS,
    maxTotalTimeout: UPSTREAM_TOOL_TIMEOUT_MS,
  };
}

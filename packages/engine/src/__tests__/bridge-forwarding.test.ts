import { describe, expect, it } from "vitest";
import {
  forwardingOptions,
  UPSTREAM_TOOL_TIMEOUT_MS,
} from "../../../mcp-bridge/src/forwarding.js";

describe("bridge forwarding lifecycle", () => {
  it("keeps long engine work alive and preserves the harness cancellation signal", () => {
    const controller = new AbortController();
    const options = forwardingOptions(controller.signal);

    expect(options.signal).toBe(controller.signal);
    expect(options.timeout).toBe(UPSTREAM_TOOL_TIMEOUT_MS);
    expect(options.maxTotalTimeout).toBe(UPSTREAM_TOOL_TIMEOUT_MS);
    expect(options.timeout).toBeGreaterThan(5 * 60_000);
  });
});

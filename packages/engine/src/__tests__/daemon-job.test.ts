import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestIndexStop } from "../daemon/http.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("index job stop lifecycle", () => {
  it("stays running until child close and automatically escalates", () => {
    vi.useFakeTimers();
    const kill = vi.fn().mockReturnValue(true);
    const child = { kill } as unknown as ChildProcess;
    const job = {
      running: true,
      phase: "drawing" as const,
      error: null,
      child,
      stopped: false,
    };

    requestIndexStop(job, 100);

    expect(job.running).toBe(true);
    expect(job.stopped).toBe(true);
    expect(job.phase).toBe("failed");
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(100);
    expect(kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("forces immediately on a second stop request", () => {
    vi.useFakeTimers();
    const kill = vi.fn().mockReturnValue(true);
    const job = {
      running: true,
      phase: "drawing" as const,
      error: null,
      child: { kill } as unknown as ChildProcess,
      stopped: false,
    };

    requestIndexStop(job);
    requestIndexStop(job);

    expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
});

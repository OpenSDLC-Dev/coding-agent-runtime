import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "../src/routes/sessions.js";

function fakeStream(over: { aborted?: boolean; closed?: boolean } = {}) {
  const writes: string[] = [];
  return {
    writes,
    aborted: over.aborted ?? false,
    closed: over.closed ?? false,
    write: (s: string) => {
      writes.push(s);
      return Promise.resolve();
    },
  };
}

describe("startHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes a keepalive comment each interval until stopped", () => {
    const s = fakeStream();
    const stop = startHeartbeat(s, 1000);
    vi.advanceTimersByTime(3000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(s.writes).toEqual([": keepalive\n\n", ": keepalive\n\n", ": keepalive\n\n"]);
  });

  it("skips writes while the stream is aborted", () => {
    const s = fakeStream({ aborted: true });
    const stop = startHeartbeat(s, 1000);
    vi.advanceTimersByTime(3000);
    stop();
    expect(s.writes).toHaveLength(0);
  });

  it("is a no-op when interval <= 0 (disabled)", () => {
    const s = fakeStream();
    const stop = startHeartbeat(s, 0);
    vi.advanceTimersByTime(10000);
    stop();
    expect(s.writes).toHaveLength(0);
  });
});

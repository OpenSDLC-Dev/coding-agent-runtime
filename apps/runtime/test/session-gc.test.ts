import { describe, expect, it, vi } from "vitest";
import { sweepIdleSessions } from "../src/agent/session-gc.js";
import { SessionRegistry } from "../src/agent/session-store.js";

// Register an idle session whose lastActiveAt is fixed at `t` (status -> idle after finishTurn).
function idleSessionAt(registry: SessionRegistry, id: string): void {
  registry.startTurn(id, { model: "m", abortController: new AbortController() });
  registry.finishTurn(id, "idle");
}

describe("sweepIdleSessions", () => {
  it("removes sessions idle longer than the TTL and reclaims their transcript", async () => {
    const registry = new SessionRegistry(() => 1000);
    idleSessionAt(registry, "old"); // lastActiveAt = 1000
    const deleteSession = vi.fn(async () => {});

    const removed = await sweepIdleSessions(
      registry,
      { deleteSession },
      { ttlMs: 500, cwd: "/workspace", now: 1000 + 501 },
    );

    expect(removed).toEqual(["old"]);
    expect(deleteSession).toHaveBeenCalledWith("old", { dir: "/workspace" });
    expect(registry.has("old")).toBe(false);
  });

  it("keeps sessions within the TTL", async () => {
    const registry = new SessionRegistry(() => 1000);
    idleSessionAt(registry, "fresh");
    const removed = await sweepIdleSessions(
      registry,
      {},
      { ttlMs: 500, cwd: "/workspace", now: 1000 + 100 },
    );
    expect(removed).toEqual([]);
    expect(registry.has("fresh")).toBe(true);
  });

  it("never collects a running turn", async () => {
    const registry = new SessionRegistry(() => 1000);
    registry.startTurn("running", { model: "m", abortController: new AbortController() }); // status = running
    const removed = await sweepIdleSessions(
      registry,
      {},
      { ttlMs: 1, cwd: "/workspace", now: 1_000_000 },
    );
    expect(removed).toEqual([]);
    expect(registry.has("running")).toBe(true);
  });

  it("is a no-op when TTL is disabled (<= 0)", async () => {
    const registry = new SessionRegistry(() => 1000);
    idleSessionAt(registry, "x");
    const removed = await sweepIdleSessions(
      registry,
      {},
      { ttlMs: 0, cwd: "/workspace", now: 9_999_999 },
    );
    expect(removed).toEqual([]);
    expect(registry.has("x")).toBe(true);
  });
});

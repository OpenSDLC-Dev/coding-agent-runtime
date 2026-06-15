import { describe, expect, it } from "vitest";
import { IdempotencyStore } from "../src/agent/idempotency.js";

function clock(start = 1000): { fn: () => number; advance: (d: number) => void } {
  let t = start;
  return { fn: () => t, advance: (d) => (t += d) };
}

describe("IdempotencyStore", () => {
  it("accepts a fresh key (null) and rejects an in-flight duplicate", () => {
    const store = new IdempotencyStore(1000);
    expect(store.begin("k1")).toBeNull();
    const dup = store.begin("k1");
    expect(dup?.status).toBe("in-flight");
  });

  it("reports the sessionId once a key completes", () => {
    const store = new IdempotencyStore(1000);
    store.begin("k1");
    store.complete("k1", "sess-1");
    const dup = store.begin("k1");
    expect(dup?.status).toBe("done");
    expect(dup?.sessionId).toBe("sess-1");
  });

  it("releasing a key lets a genuine retry through", () => {
    const store = new IdempotencyStore(1000);
    store.begin("k1");
    store.release("k1");
    expect(store.begin("k1")).toBeNull();
  });

  it("expires entries past the TTL so the key can be reused", () => {
    const c = clock();
    const store = new IdempotencyStore(1000, c.fn);
    store.begin("k1");
    store.complete("k1", "sess-1");
    c.advance(1001);
    expect(store.begin("k1")).toBeNull();
  });

  it("is a no-op (never dedups) when the TTL is disabled (<= 0)", () => {
    const store = new IdempotencyStore(0);
    expect(store.begin("k1")).toBeNull();
    expect(store.begin("k1")).toBeNull();
  });

  it("bounds its size by evicting the oldest entries", () => {
    const store = new IdempotencyStore(1_000_000, undefined, 2);
    store.begin("k1");
    store.begin("k2");
    store.begin("k3"); // evicts k1 (oldest)
    expect(store.begin("k1")).toBeNull(); // k1 was evicted → treated as fresh
    expect(store.begin("k3")?.status).toBe("in-flight"); // k3 still tracked
  });
});

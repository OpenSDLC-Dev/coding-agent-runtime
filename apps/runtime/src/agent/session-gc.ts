import type { RuntimeConfig } from "./config.js";
import type { SessionRegistry } from "./session-store.js";

// Minimal SDK surface the GC needs (deleteSession reclaims the on-disk transcript).
interface GcSdk {
  deleteSession?: (id: string, opts: { dir: string }) => Promise<void>;
}

// One GC pass: remove every session idle longer than ttlMs, reclaiming its on-disk transcript.
// A running turn is never collected. ttlMs <= 0 disables GC (no-op). `now` is injectable for tests.
export async function sweepIdleSessions(
  registry: SessionRegistry,
  sdk: GcSdk,
  opts: { ttlMs: number; cwd: string; now?: number },
): Promise<string[]> {
  if (opts.ttlMs <= 0) return [];
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  for (const s of registry.list()) {
    if (s.status === "running") continue; // never GC an active turn
    if (now - s.lastActiveAt < opts.ttlMs) continue;
    if (sdk.deleteSession) {
      try {
        await sdk.deleteSession(s.id, { dir: opts.cwd });
      } catch (err) {
        console.error("[gc] deleteSession failed:", err);
      }
    }
    registry.remove(s.id);
    removed.push(s.id);
  }
  return removed;
}

// Start the periodic idle-session GC; returns a stop function. No-op (returns a no-op stopper) when GC is disabled.
// The interval is unref()'d so it never holds the process open on its own.
export function startSessionGc(
  registry: SessionRegistry,
  sdk: GcSdk,
  config: Pick<RuntimeConfig, "sessionTtlMs" | "gcIntervalMs" | "cwd">,
): () => void {
  if (config.sessionTtlMs <= 0) return () => {};
  const timer = setInterval(() => {
    void sweepIdleSessions(registry, sdk, { ttlMs: config.sessionTtlMs, cwd: config.cwd });
  }, config.gcIntervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

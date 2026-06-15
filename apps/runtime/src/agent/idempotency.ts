export type IdempotencyStatus = "in-flight" | "done";

export interface IdempotencyEntry {
  status: IdempotencyStatus;
  sessionId?: string;
  at: number; // last-updated timestamp (ms)
}

// In-process Idempotency-Key store: a client that sends an `Idempotency-Key` header gets at-most-once
// turn submission. A key is reserved when its request is admitted (`begin`), flipped to `done` (with the
// resulting sessionId) when the turn finishes, and dropped on failure so a genuine retry can proceed.
// The container is single-process and stateless — losing this table on restart is acceptable. Entries
// expire after ttlMs and the map is size-bounded (oldest evicted) so it cannot grow without limit.
export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 1024,
  ) {}

  // Atomically reserve a key for a new request. Returns null when accepted (caller proceeds), or the
  // existing entry when this is a duplicate (caller rejects with 409). Disabled (no-op) when ttlMs <= 0.
  begin(key: string): IdempotencyEntry | null {
    if (this.ttlMs <= 0) return null;
    this.pruneExpired();
    const existing = this.entries.get(key);
    if (existing && !this.isExpired(existing)) return existing;
    // New (or expired) key → drop any stale entry for it, bound the map, then reserve.
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value; // Map preserves insertion order: first = oldest.
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { status: "in-flight", at: this.now() });
    return null;
  }

  // Flip a key to done, recording the sessionId the turn produced.
  complete(key: string, sessionId: string | undefined): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.status = "done";
    e.sessionId = sessionId;
    e.at = this.now();
  }

  // Drop a key's reservation so a genuine retry can proceed (the turn errored or was aborted).
  release(key: string): void {
    this.entries.delete(key);
  }

  private isExpired(e: IdempotencyEntry): boolean {
    return this.now() - e.at > this.ttlMs;
  }

  private pruneExpired(): void {
    for (const [k, e] of this.entries) if (this.isExpired(e)) this.entries.delete(k);
  }
}

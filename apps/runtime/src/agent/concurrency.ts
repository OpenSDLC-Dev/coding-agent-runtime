// Minimal counting semaphore for turn admission control.
// tryAcquire() returns false when at capacity (so the caller can reject with HTTP 429) instead of queueing.
// A limit <= 0 means unlimited: tryAcquire always succeeds and release is a no-op.
export class Semaphore {
  private inUse = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.limit <= 0) return true; // unlimited
    if (this.inUse >= this.limit) return false;
    this.inUse += 1;
    return true;
  }

  release(): void {
    if (this.limit <= 0) return;
    if (this.inUse > 0) this.inUse -= 1;
  }

  get active(): number {
    return this.inUse;
  }
}

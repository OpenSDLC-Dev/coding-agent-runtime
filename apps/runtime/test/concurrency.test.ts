import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/agent/concurrency.js";

describe("Semaphore", () => {
  it("admits up to the limit, then refuses", () => {
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    expect(sem.active).toBe(2);
  });

  it("frees a slot on release", () => {
    const sem = new Semaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });

  it("never goes negative on extra release", () => {
    const sem = new Semaphore(1);
    sem.release(); // no slot held
    expect(sem.active).toBe(0);
    expect(sem.tryAcquire()).toBe(true);
  });

  it("is unlimited when limit <= 0", () => {
    const sem = new Semaphore(0);
    for (let i = 0; i < 100; i++) expect(sem.tryAcquire()).toBe(true);
    expect(sem.active).toBe(0); // unlimited mode does not track usage
  });
});

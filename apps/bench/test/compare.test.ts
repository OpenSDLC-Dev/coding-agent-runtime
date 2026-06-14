import { describe, expect, it } from "vitest";
import { baselineFromReport } from "../src/baseline.js";
import { compare, exitCodeForVerdict } from "../src/compare.js";
import { makeReport, makeSummary } from "./tracking-fixtures.js";

// A baseline pinned at resolveRate 0.6 (3/5), built from the default report.
const baseline = baselineFromReport(makeReport(), 0);

describe("compare", () => {
  it("is 'new' (no gate) when there is no committed baseline", () => {
    const r = compare(null, makeReport());
    expect(r.verdict).toBe("new");
    expect(r.baselineRate).toBeNull();
    expect(exitCodeForVerdict(r.verdict)).toBe(0);
  });

  it("is 'regress' when the resolve rate drops", () => {
    const report = makeReport({ summary: makeSummary({ resolved: 2, resolveRate: 0.4 }) });
    const r = compare(baseline, report);
    expect(r.verdict).toBe("regress");
    expect(r.rateDelta).toBeCloseTo(-0.2);
    expect(exitCodeForVerdict(r.verdict)).toBe(1);
  });

  it("is 'improve' when the resolve rate rises", () => {
    const report = makeReport({ summary: makeSummary({ resolved: 4, resolveRate: 0.8 }) });
    const r = compare(baseline, report);
    expect(r.verdict).toBe("improve");
    expect(exitCodeForVerdict(r.verdict)).toBe(0);
  });

  it("is 'pass' when the resolve rate is unchanged", () => {
    expect(compare(baseline, makeReport()).verdict).toBe("pass");
  });

  it("absorbs a drop within tolerance, but not beyond it", () => {
    const report = makeReport({ summary: makeSummary({ resolved: 2, resolveRate: 0.4 }) });
    expect(compare(baseline, report, { tolerance: 0.25 }).verdict).toBe("pass");
    expect(compare(baseline, report, { tolerance: 0.1 }).verdict).toBe("regress");
  });

  it("treats a drop exactly equal to the tolerance as a pass (boundary is inclusive)", () => {
    // delta = 0.4 - 0.6 = -0.2, tolerance 0.2 -> rateDelta === -tolerance, not a regression.
    const report = makeReport({ summary: makeSummary({ resolved: 2, resolveRate: 0.4 }) });
    expect(compare(baseline, report, { tolerance: 0.2 }).verdict).toBe("pass");
  });

  it("reports cost/turn deltas but never gates on them", () => {
    // Same resolve rate, but much costlier and slower -> still a pass.
    const report = makeReport({
      summary: makeSummary({ totalCostUsd: 99, totalTurns: 999 }),
    });
    const r = compare(baseline, report);
    expect(r.verdict).toBe("pass");
    expect(r.costDelta).toBeCloseTo(99 - 0.1);
    expect(r.turnsDelta).toBe(999 - 10);
  });
});

import { describe, expect, it } from "vitest";
import { baselineFromReport } from "../src/baseline.js";
import { renderBenchmarks } from "../src/report/markdown.js";
import { makeReport, makeSnapshot, makeSummary } from "./tracking-fixtures.js";

describe("renderBenchmarks", () => {
  it("renders a deterministic 'no baselines' placeholder", () => {
    const out = renderBenchmarks([]);
    expect(out).toContain("# Benchmarks");
    expect(out).toContain("No accepted baselines yet");
    expect(renderBenchmarks([])).toBe(out); // deterministic
  });

  it("renders one row per baseline with the key cells", () => {
    const b = baselineFromReport(
      makeReport({
        config: makeSnapshot({ benchmark: "swe-bench", backendLabel: "minimax-m3" }),
        summary: makeSummary({ resolved: 4, total: 5, resolveRate: 0.8 }),
      }),
      0,
    );
    const out = renderBenchmarks([b]);
    expect(out).toContain("| Benchmark | Split | Backend |");
    expect(out).toContain("swe-bench");
    expect(out).toContain("minimax-m3");
    expect(out).toContain("80.0% (4/5)");
    expect(out).toContain(`\`${b.key}\``);
  });

  it("is deterministic and stably ordered regardless of input order", () => {
    const a = baselineFromReport(makeReport({ config: makeSnapshot({ backendLabel: "aaa" }) }), 0);
    const z = baselineFromReport(makeReport({ config: makeSnapshot({ backendLabel: "zzz" }) }), 0);
    expect(renderBenchmarks([a, z])).toBe(renderBenchmarks([z, a]));
  });
});

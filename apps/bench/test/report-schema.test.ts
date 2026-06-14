import { describe, expect, it } from "vitest";
import { type RunReport, RunReportSchema } from "../src/report/schema.js";

const valid: RunReport = {
  schemaVersion: 2,
  benchmark: "hello-bench",
  config: {
    benchmark: "hello-bench",
    datasetSplit: "builtin",
    subsetHash: "abc",
    backendLabel: "test",
    model: "m",
    effort: "max",
    maxTurns: 100,
    promptScaffoldVersion: "1",
    runtimeVersion: "0.0.0",
    harnessVersion: "0.0.0",
  },
  startedAt: 1,
  finishedAt: 2,
  summary: {
    total: 1,
    resolved: 1,
    unresolved: 0,
    errored: 0,
    resolveRate: 1,
    totalCostUsd: 0.01,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalTurns: 1,
    wallTimeMs: 1,
  },
  instances: [
    {
      instanceId: "a",
      status: "resolved",
      turns: 1,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
      wallTimeMs: 1,
      sessionId: "s",
      traceId: null,
    },
  ],
};

describe("RunReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(RunReportSchema.parse(valid).summary.resolveRate).toBe(1);
  });

  it("rejects an unknown instance status", () => {
    const bad = { ...valid, instances: [{ ...valid.instances[0], status: "bogus" }] };
    expect(() => RunReportSchema.parse(bad)).toThrow();
  });

  it("rejects a resolveRate above 1", () => {
    const bad = { ...valid, summary: { ...valid.summary, resolveRate: 1.5 } };
    expect(() => RunReportSchema.parse(bad)).toThrow();
  });

  it("rejects a wrong schemaVersion", () => {
    const bad = { ...valid, schemaVersion: 1 };
    expect(() => RunReportSchema.parse(bad)).toThrow();
  });

  it("rejects a report missing the embedded config tuple", () => {
    const { config: _omit, ...withoutConfig } = valid;
    expect(() => RunReportSchema.parse(withoutConfig)).toThrow();
  });
});

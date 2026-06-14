// Shared builders for baseline/compare/history/runner tests: a config snapshot, a run summary, and a
// full RunReport, each with sensible defaults and shallow overrides. Synthetic only -- no real data.

import type { ConfigSnapshot } from "../src/config-snapshot.js";
import type { RunReport, RunSummary } from "../src/report/schema.js";

export function makeSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    benchmark: "hello-bench",
    datasetSplit: "builtin",
    subsetHash: "deadbeefdeadbeef",
    backendLabel: "test-backend",
    model: "test-model",
    effort: "max",
    maxTurns: 100,
    promptScaffoldVersion: "1",
    runtimeVersion: "0.0.0",
    harnessVersion: "0.0.0",
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    total: 5,
    resolved: 3,
    unresolved: 2,
    errored: 0,
    resolveRate: 0.6,
    totalCostUsd: 0.1,
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalTurns: 10,
    wallTimeMs: 1000,
    ...overrides,
  };
}

export function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: 2,
    benchmark: "hello-bench",
    config: makeSnapshot(),
    startedAt: 1000,
    finishedAt: 2000,
    summary: makeSummary(),
    instances: [],
    ...overrides,
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBenchmark } from "../src/runner.js";
import { stubScorer } from "../src/scorer/stub.js";
import type { RuntimeClient } from "../src/sse-client.js";
import type { BenchAdapter, TurnOutcome } from "../src/types.js";

function outcome(partial: Partial<TurnOutcome>): TurnOutcome {
  return {
    sessionId: "s",
    terminal: "result",
    isError: false,
    numTurns: 1,
    inputTokens: 5,
    outputTokens: 7,
    costUsd: 0.002,
    traceId: null,
    ...partial,
  };
}

function fakeClient(byPrompt: Record<string, TurnOutcome>): RuntimeClient {
  return {
    async health() {
      return true;
    },
    async runTurn({ prompt }) {
      return byPrompt[prompt] ?? outcome({});
    },
  };
}

const threeInstanceAdapter: BenchAdapter = {
  name: "test-bench",
  datasetSplit: "builtin",
  instances: () => [
    { id: "a", prompt: "pa", seedFiles: { "x.txt": "a" } },
    { id: "b", prompt: "pb", seedFiles: { "y.txt": "b" } },
    { id: "c", prompt: "pc", seedFiles: {} },
  ],
};

const oneInstanceAdapter = (id: string, prompt: string): BenchAdapter => ({
  name: "t",
  datasetSplit: "builtin",
  instances: () => [{ id, prompt, seedFiles: {} }],
});

describe("runBenchmark", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "bench-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("aggregates per-instance statuses and summary math", async () => {
    let t = 1000;
    const now = (): number => {
      t += 10;
      return t;
    };
    const client = fakeClient({
      pa: outcome({ numTurns: 2, inputTokens: 10, outputTokens: 20, costUsd: 0.01 }),
      pb: outcome({ numTurns: 1, inputTokens: 4, outputTokens: 6, costUsd: 0.005 }),
      pc: outcome({
        terminal: "aborted",
        numTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }),
    });
    const scorer = stubScorer({ a: { resolved: true }, b: { resolved: false } });

    const report = await runBenchmark({
      adapter: threeInstanceAdapter,
      client,
      scorer,
      workspaceDir: ws,
      now,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.benchmark).toBe("test-bench");
    expect(report.instances.map((i) => i.status)).toEqual(["resolved", "unresolved", "timeout"]);
    expect(report.summary.total).toBe(3);
    expect(report.summary.resolved).toBe(1);
    expect(report.summary.unresolved).toBe(1);
    expect(report.summary.errored).toBe(1); // the timeout folds into the errored bucket
    expect(report.summary.resolveRate).toBeCloseTo(1 / 3);
    expect(report.summary.totalInputTokens).toBe(14);
    expect(report.summary.totalTurns).toBe(3);
    expect(report.summary.totalCostUsd).toBeCloseTo(0.015);
  });

  it("marks an instance errored when the client throws", async () => {
    const client: RuntimeClient = {
      async health() {
        return true;
      },
      async runTurn() {
        throw new Error("connection refused");
      },
    };
    const report = await runBenchmark({
      adapter: oneInstanceAdapter("x", "p"),
      client,
      scorer: stubScorer({}),
      workspaceDir: ws,
    });
    expect(report.instances[0]?.status).toBe("errored");
    expect(report.instances[0]?.error).toMatch(/connection refused/);
  });

  it("marks a result carrying is_error as errored (never scored)", async () => {
    const client = fakeClient({ p: outcome({ isError: true }) });
    const report = await runBenchmark({
      adapter: oneInstanceAdapter("x", "p"),
      client,
      scorer: stubScorer({ x: { resolved: true } }),
      workspaceDir: ws,
    });
    expect(report.instances[0]?.status).toBe("errored");
  });
});

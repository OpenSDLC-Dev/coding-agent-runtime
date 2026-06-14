import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBenchmark } from "../src/runner.js";
import { stubScorer } from "../src/scorer/stub.js";
import type { BatchScorer, Prediction } from "../src/scorer/types.js";
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

  it("requires exactly one of scorer or batch", async () => {
    await expect(
      runBenchmark({
        adapter: oneInstanceAdapter("x", "p"),
        client: fakeClient({}),
        workspaceDir: ws,
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("awaits adapter.load() before reading instances()", async () => {
    let loaded = false;
    const adapter: BenchAdapter = {
      name: "t",
      datasetSplit: "x",
      async load() {
        loaded = true;
      },
      instances() {
        if (!loaded) throw new Error("instances() called before load()");
        return [{ id: "i", prompt: "p", seedFiles: {} }];
      },
    };
    const report = await runBenchmark({
      adapter,
      client: fakeClient({ p: outcome({}) }),
      scorer: stubScorer({ i: { resolved: true } }),
      workspaceDir: ws,
    });
    expect(report.instances[0]?.status).toBe("resolved");
  });

  it("calls prepare after reset and before seedFiles + the turn", async () => {
    const order: string[] = [];
    const adapter: BenchAdapter = {
      name: "t",
      datasetSplit: "x",
      instances: () => [
        {
          id: "i",
          prompt: "p",
          seedFiles: { "seed.txt": "x" },
          async prepare(wsDir) {
            order.push("prepare");
            // resetWorkspace emptied the dir and seedFiles has not run yet.
            expect(await readdir(wsDir)).not.toContain("seed.txt");
          },
        },
      ],
    };
    const client: RuntimeClient = {
      async health() {
        return true;
      },
      async runTurn() {
        order.push("turn");
        // seedFiles ran before the turn.
        expect(await readdir(ws)).toContain("seed.txt");
        return outcome({});
      },
    };
    await runBenchmark({
      adapter,
      client,
      scorer: stubScorer({ i: { resolved: true } }),
      workspaceDir: ws,
    });
    expect(order).toEqual(["prepare", "turn"]);
  });

  it("errors a failing prepare but continues the run", async () => {
    const adapter: BenchAdapter = {
      name: "t",
      datasetSplit: "x",
      instances: () => [
        {
          id: "bad",
          prompt: "p1",
          seedFiles: {},
          prepare: async () => {
            throw new Error("clone failed");
          },
        },
        { id: "ok", prompt: "p2", seedFiles: {} },
      ],
    };
    const report = await runBenchmark({
      adapter,
      client: fakeClient({ p2: outcome({}) }),
      scorer: stubScorer({ ok: { resolved: true } }),
      workspaceDir: ws,
    });
    expect(report.instances[0]?.status).toBe("errored");
    expect(report.instances[0]?.error).toMatch(/clone failed/);
    expect(report.instances[1]?.status).toBe("resolved");
  });

  it("removes a .git left by prepare so the next instance's reset succeeds", async () => {
    const cloneAdapter = (prompt: string): BenchAdapter => ({
      name: "t",
      datasetSplit: "x",
      instances: () => [
        {
          id: "i1",
          prompt,
          seedFiles: {},
          prepare: async (wsDir) => {
            await mkdir(join(wsDir, ".git"));
          },
        },
        {
          id: "i2",
          prompt,
          seedFiles: {},
          prepare: async (wsDir) => {
            await mkdir(join(wsDir, ".git"));
          },
        },
      ],
    });
    // Both a completed and an aborted turn must leave the workspace clean for the next reset.
    for (const term of ["result", "aborted"] as const) {
      const report = await runBenchmark({
        adapter: cloneAdapter("p"),
        client: fakeClient({ p: outcome({ terminal: term }) }),
        scorer: stubScorer({ i1: { resolved: true }, i2: { resolved: true } }),
        workspaceDir: ws,
      });
      // Neither instance is errored by a "refusing to wipe a git repository" reset failure.
      expect(report.instances.every((i) => i.error === undefined)).toBe(true);
      expect(await readdir(ws)).not.toContain(".git");
    }
  });

  it("batch path: collects predictions for completed turns, scores once, folds verdicts", async () => {
    const adapter: BenchAdapter = {
      name: "swe",
      datasetSplit: "lite-curated",
      instances: () => [
        { id: "i1", prompt: "p1", seedFiles: {} },
        { id: "i2", prompt: "p2", seedFiles: {} },
        { id: "i3", prompt: "p3", seedFiles: {} },
      ],
    };
    const client = fakeClient({
      p1: outcome({}),
      p2: outcome({}),
      p3: outcome({ terminal: "aborted" }),
    });
    let scored: Prediction[] | null = null;
    const batchScorer: BatchScorer = {
      async scoreAll(preds) {
        scored = preds;
        return new Map([
          ["i1", { resolved: true }],
          ["i2", { resolved: false, detail: "tests failed" }],
        ]);
      },
    };
    const report = await runBenchmark({
      adapter,
      client,
      workspaceDir: ws,
      batch: { scorer: batchScorer, collectPatch: async () => "DIFF", modelName: "cr" },
    });
    // Only the two completed turns produce predictions; the aborted one does not.
    expect(scored?.map((p) => p.instance_id)).toEqual(["i1", "i2"]);
    expect(scored?.every((p) => p.model_patch === "DIFF" && p.model_name_or_path === "cr")).toBe(
      true,
    );
    expect(report.instances.map((i) => i.status)).toEqual(["resolved", "unresolved", "timeout"]);
  });

  it("batch path: a completed turn missing from the verdict map is errored", async () => {
    const report = await runBenchmark({
      adapter: oneInstanceAdapter("x", "p"),
      client: fakeClient({ p: outcome({}) }),
      workspaceDir: ws,
      batch: {
        scorer: {
          async scoreAll() {
            return new Map();
          },
        },
        collectPatch: async () => "DIFF",
        modelName: "cr",
      },
    });
    expect(report.instances[0]?.status).toBe("errored");
    expect(report.instances[0]?.error).toMatch(/missing/);
  });

  it("batch path: a grader failure errors pending instances but still builds a report with turn data", async () => {
    const report = await runBenchmark({
      adapter: oneInstanceAdapter("x", "p"),
      client: fakeClient({ p: outcome({ numTurns: 3, costUsd: 0.02 }) }),
      workspaceDir: ws,
      batch: {
        scorer: {
          async scoreAll() {
            throw new Error("report not found");
          },
        },
        collectPatch: async () => "DIFF",
        modelName: "cr",
      },
    });
    expect(report.instances[0]?.status).toBe("errored");
    expect(report.instances[0]?.error).toMatch(/batch scoring failed: report not found/);
    // The paid turn data is preserved, not discarded.
    expect(report.instances[0]?.turns).toBe(3);
    expect(report.summary.totalCostUsd).toBeCloseTo(0.02);
  });

  it("batch path: removes a .git left by prepare even when the turn aborts", async () => {
    const adapter: BenchAdapter = {
      name: "swe",
      datasetSplit: "x",
      instances: () => [
        {
          id: "i1",
          prompt: "p",
          seedFiles: {},
          prepare: (w) => mkdir(join(w, ".git")).then(() => {}),
        },
        {
          id: "i2",
          prompt: "p",
          seedFiles: {},
          prepare: (w) => mkdir(join(w, ".git")).then(() => {}),
        },
      ],
    };
    const report = await runBenchmark({
      adapter,
      client: fakeClient({ p: outcome({ terminal: "aborted" }) }),
      workspaceDir: ws,
      batch: {
        scorer: {
          async scoreAll() {
            return new Map();
          },
        },
        collectPatch: async () => "DIFF",
        modelName: "cr",
      },
    });
    expect(report.instances.map((i) => i.status)).toEqual(["timeout", "timeout"]);
    expect(await readdir(ws)).not.toContain(".git");
  });

  it("removes a .git left by prepare even when the turn throws", async () => {
    const adapter: BenchAdapter = {
      name: "t",
      datasetSplit: "x",
      instances: () => [
        {
          id: "i1",
          prompt: "p",
          seedFiles: {},
          prepare: (w) => mkdir(join(w, ".git")).then(() => {}),
        },
        {
          id: "i2",
          prompt: "p",
          seedFiles: {},
          prepare: (w) => mkdir(join(w, ".git")).then(() => {}),
        },
      ],
    };
    const client: RuntimeClient = {
      async health() {
        return true;
      },
      async runTurn() {
        throw new Error("boom");
      },
    };
    const report = await runBenchmark({
      adapter,
      client,
      scorer: stubScorer({}),
      workspaceDir: ws,
    });
    expect(report.instances.map((i) => i.status)).toEqual(["errored", "errored"]);
    expect(await readdir(ws)).not.toContain(".git");
  });
});

// The outer loop: for each instance, reset + seed the workspace, drive one turn against the runtime,
// score the post-turn workspace, and record a result. Sequential by design — the runtime is single
// workspace / single task, so instances cannot share a workspace. Aggregates into a validated
// RunReport. Token/cost/turn figures are pure aggregation of what the `result` SSE event already
// reports; the harness adds no new measurement.

import {
  type InstanceResult,
  type InstanceStatus,
  type RunReport,
  RunReportSchema,
} from "./report/schema.js";
import type { Scorer } from "./scorer/types.js";
import type { RuntimeClient } from "./sse-client.js";
import type { BenchAdapter, BenchInstance, TurnOutcome } from "./types.js";
import { resetWorkspace, seedFiles } from "./workspace.js";

export interface RunOptions {
  adapter: BenchAdapter;
  client: RuntimeClient;
  scorer: Scorer;
  workspaceDir: string;
  model?: string;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
  /** Optional progress sink. */
  log?: (message: string) => void;
}

async function classify(
  instance: BenchInstance,
  outcome: TurnOutcome,
  scorer: Scorer,
  workspaceDir: string,
): Promise<InstanceStatus> {
  if (outcome.terminal === "aborted") return "timeout";
  if (outcome.terminal !== "result" || outcome.isError) return "errored";
  const verdict = await scorer.score(instance, { workspaceDir });
  return verdict.resolved ? "resolved" : "unresolved";
}

function buildReport(
  benchmark: string,
  startedAt: number,
  finishedAt: number,
  instances: InstanceResult[],
): RunReport {
  const total = instances.length;
  const count = (s: InstanceStatus): number => instances.filter((i) => i.status === s).length;
  const resolved = count("resolved");
  const unresolved = count("unresolved");
  // The summary's "errored" bucket folds in timeouts so that resolved + unresolved + errored === total.
  const errored = count("errored") + count("timeout");
  const sum = (sel: (i: InstanceResult) => number): number =>
    instances.reduce((acc, i) => acc + sel(i), 0);
  const report: RunReport = {
    schemaVersion: 1,
    benchmark,
    startedAt,
    finishedAt,
    summary: {
      total,
      resolved,
      unresolved,
      errored,
      resolveRate: total === 0 ? 0 : resolved / total,
      totalCostUsd: sum((i) => i.costUsd),
      totalInputTokens: sum((i) => i.inputTokens),
      totalOutputTokens: sum((i) => i.outputTokens),
      totalTurns: sum((i) => i.turns),
      wallTimeMs: finishedAt - startedAt,
    },
    instances,
  };
  // Validate on the way out: a malformed report is a bug, not a number to trust.
  return RunReportSchema.parse(report);
}

export async function runBenchmark(opts: RunOptions): Promise<RunReport> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => {});
  const startedAt = now();
  const results: InstanceResult[] = [];

  for (const instance of opts.adapter.instances()) {
    const t0 = now();
    let result: InstanceResult;
    try {
      await resetWorkspace(opts.workspaceDir);
      await seedFiles(opts.workspaceDir, instance.seedFiles);
      const outcome = await opts.client.runTurn({ prompt: instance.prompt, model: opts.model });
      const status = await classify(instance, outcome, opts.scorer, opts.workspaceDir);
      result = {
        instanceId: instance.id,
        status,
        turns: outcome.numTurns,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        costUsd: outcome.costUsd,
        wallTimeMs: now() - t0,
        sessionId: outcome.sessionId,
        traceId: outcome.traceId,
      };
    } catch (err) {
      result = {
        instanceId: instance.id,
        status: "errored",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallTimeMs: now() - t0,
        sessionId: null,
        traceId: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    log(`${instance.id}: ${result.status}`);
    results.push(result);
  }

  return buildReport(opts.adapter.name, startedAt, now(), results);
}

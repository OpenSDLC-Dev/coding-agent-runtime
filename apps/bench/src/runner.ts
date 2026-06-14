// The outer loop: for each instance, reset + prepare + seed the workspace, drive one turn against the
// runtime, and record a result. Sequential by design — the runtime is single workspace / single task,
// so instances cannot share a workspace. Aggregates into a validated RunReport. Token/cost/turn figures
// are pure aggregation of what the `result` SSE event already reports; the harness adds no measurement.
//
// Two scoring modes:
//   - per-instance (`scorer`): score the post-turn workspace inline (the local hello-bench path).
//   - batch (`batch`): some graders (SWE-bench) cannot score one instance at a time — they take the
//     whole run's predictions in one shot. So we collect a Prediction per completed turn, score them
//     all once after the loop, and fold the per-instance verdicts back in.

import {
  type InstanceResult,
  type InstanceStatus,
  type RunReport,
  RunReportSchema,
} from "./report/schema.js";
import type { BatchScorer, Prediction, Scorer } from "./scorer/types.js";
import type { RuntimeClient } from "./sse-client.js";
import type { BenchAdapter, BenchInstance, TurnOutcome } from "./types.js";
import { removeGitDir, resetWorkspace, seedFiles } from "./workspace.js";

/** Batch scoring for graders that evaluate the whole run's predictions at once (e.g. SWE-bench). */
export interface BatchConfig {
  scorer: BatchScorer;
  /** Collect the agent's solution as a unified diff from the post-turn workspace (injectable git). */
  collectPatch: (workspaceDir: string) => Promise<string>;
  /** model_name_or_path stamped on each prediction. */
  modelName: string;
}

export interface RunOptions {
  adapter: BenchAdapter;
  client: RuntimeClient;
  workspaceDir: string;
  /** Per-instance scorer (hello-bench). Exactly one of `scorer` / `batch` must be set. */
  scorer?: Scorer;
  /** Batch scorer (SWE-bench). Exactly one of `scorer` / `batch` must be set. */
  batch?: BatchConfig;
  model?: string;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
  /** Optional progress sink. */
  log?: (message: string) => void;
}

function baseResult(instanceId: string, outcome: TurnOutcome, wallTimeMs: number): InstanceResult {
  return {
    instanceId,
    status: "errored",
    turns: outcome.numTurns,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    costUsd: outcome.costUsd,
    wallTimeMs,
    sessionId: outcome.sessionId,
    traceId: outcome.traceId,
  };
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
  if ((opts.scorer ? 1 : 0) + (opts.batch ? 1 : 0) !== 1) {
    throw new Error("runBenchmark requires exactly one of `scorer` or `batch`");
  }
  await opts.adapter.load?.();
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => {});
  const startedAt = now();
  const results: InstanceResult[] = [];
  const predictions: Prediction[] = [];
  // Results awaiting a batch verdict, by instance id. They share object identity with `results`, so
  // overwriting status here after scoring is reflected in the final report.
  const pending = new Map<string, InstanceResult>();

  for (const instance of opts.adapter.instances()) {
    const t0 = now();
    let result: InstanceResult;
    try {
      // resetWorkspace runs OUTSIDE the cleanup scope below: its repo-root guard must be able to refuse
      // a misconfigured workspace (a real checkout) *before* anything — including .git removal — runs.
      await resetWorkspace(opts.workspaceDir);
      try {
        if (instance.prepare) await instance.prepare(opts.workspaceDir);
        await seedFiles(opts.workspaceDir, instance.seedFiles);
        const outcome = await opts.client.runTurn({ prompt: instance.prompt, model: opts.model });
        if (opts.batch) {
          if (outcome.terminal === "result" && !outcome.isError) {
            const patch = await opts.batch.collectPatch(opts.workspaceDir);
            predictions.push({
              instance_id: instance.id,
              model_name_or_path: opts.batch.modelName,
              model_patch: patch,
            });
            result = baseResult(instance.id, outcome, now() - t0); // status filled by batch scoring
            pending.set(instance.id, result);
          } else {
            result = {
              ...baseResult(instance.id, outcome, now() - t0),
              status: outcome.terminal === "aborted" ? "timeout" : "errored",
            };
          }
        } else {
          const status = await classify(
            instance,
            outcome,
            opts.scorer as Scorer,
            opts.workspaceDir,
          );
          result = { ...baseResult(instance.id, outcome, now() - t0), status };
        }
      } finally {
        // Unconditionally remove any .git a prepare() clone left, even on a timed-out/errored turn (the
        // common SWE-bench case), so the next instance's resetWorkspace sees a plain tree.
        await removeGitDir(opts.workspaceDir);
      }
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

  if (opts.batch) {
    try {
      const verdicts = await opts.batch.scorer.scoreAll(predictions);
      for (const [id, result] of pending) {
        const verdict = verdicts.get(id);
        if (!verdict || verdict.errored) {
          result.status = "errored";
          result.error = verdict?.detail ?? "instance missing from scorer report";
        } else {
          result.status = verdict.resolved ? "resolved" : "unresolved";
        }
      }
    } catch (err) {
      // A whole-run grader failure (e.g. the report never landed) must not throw away the turn data we
      // already paid for: mark the scored-pending instances errored and still build the report. The
      // predictions file the scorer wrote survives, so scoring can be re-run against it out of band.
      const message = err instanceof Error ? err.message : String(err);
      for (const result of pending.values()) {
        result.status = "errored";
        result.error = `batch scoring failed: ${message}`;
      }
    }
  }

  return buildReport(opts.adapter.name, startedAt, now(), results);
}

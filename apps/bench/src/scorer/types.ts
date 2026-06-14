// The scorer is the pluggable boundary that turns a post-turn workspace into a pass/fail verdict.
// E0 ships a stub (canned verdicts, for unit tests) and a local-check scorer (runs the instance's
// own check). Later milestones add authoritative SWE-bench scorers (hosted sb-cli / local Docker)
// behind this same interface, so nothing downstream changes when the scoring backend does.

import type { BenchInstance } from "../types.js";

export interface Verdict {
  resolved: boolean;
  detail?: string;
}

export interface ScoreContext {
  workspaceDir: string;
}

export interface Scorer {
  score(instance: BenchInstance, ctx: ScoreContext): Promise<Verdict>;
}

// Some benchmarks (SWE-bench) cannot be scored one instance at a time: the authoritative grader takes
// the whole run's predictions file, evaluates it in one batch, and emits a single aggregate report.
// The BatchScorer models that — the runner collects a Prediction per completed turn during the loop,
// then scores them all once afterwards and folds the per-instance verdicts back in.

/** A single prediction in the format both the local swebench harness and sb-cli accept. */
export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  /** The agent's solution as a unified `git diff` against the instance's base commit. */
  model_patch: string;
}

/** A per-instance verdict from batch scoring. `errored` distinguishes a grader/harness failure (or an
 *  instance missing from the report) from an honest unresolved (tests failed / empty patch). */
export interface BatchVerdict {
  resolved: boolean;
  errored?: boolean;
  detail?: string;
}

export interface BatchScorer {
  scoreAll(predictions: Prediction[]): Promise<Map<string, BatchVerdict>>;
}

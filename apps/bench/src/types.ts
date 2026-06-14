// Core types shared across the benchmark harness. The harness drives the runtime as a black box
// over its public HTTP/SSE contract (it never imports runtime internals), so these types model only
// what an external orchestrator needs: a task to run, and the observable outcome of a turn.

/** Terminal SSE event observed for a turn. `none` means the stream ended without a terminal event. */
export type TerminalKind = "result" | "error" | "aborted" | "none";

/** The reduced, observable result of driving one turn against the runtime. */
export interface TurnOutcome {
  sessionId: string | null;
  terminal: TerminalKind;
  isError: boolean;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  traceId: string | null;
}

/** A single benchmark task: a prompt, the files to materialize before the turn, and an optional
 *  local resolution check. External benchmarks (e.g. SWE-bench) score out-of-band and omit `check`. */
export interface BenchInstance {
  id: string;
  prompt: string;
  /** Workspace-relative path -> file content, materialized into a clean workspace before the turn. */
  seedFiles: Record<string, string>;
  /** Optional async workspace materialization run AFTER resetWorkspace and BEFORE seedFiles — the seam
   *  for setup that static file contents cannot express, e.g. `git clone` of a repo at a base commit
   *  (SWE-bench). Anything it creates under the workspace is wiped on the next instance's reset; the
   *  runner unconditionally removes a `.git` it leaves so the reset's repo-guard never trips. */
  prepare?: (workspaceDir: string) => Promise<void>;
  /** Inspect the post-turn workspace; resolve true when the task is solved. Used by localCheckScorer. */
  check?: (workspaceDir: string) => Promise<boolean>;
}

/** A benchmark: a named set of instances plus its dataset provenance. */
export interface BenchAdapter {
  name: string;
  datasetSplit: string;
  /** Optional async initialization (e.g. read a dataset file off disk) the runner awaits before it
   *  first calls instances(). Keeping it on the interface — rather than an out-of-band method — means
   *  the runner always invokes it, so an adapter that needs loading cannot be silently used unloaded. */
  load?(): Promise<void>;
  instances(): BenchInstance[];
}

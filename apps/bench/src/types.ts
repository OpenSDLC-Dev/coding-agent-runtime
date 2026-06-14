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
  /** Inspect the post-turn workspace; resolve true when the task is solved. Used by localCheckScorer. */
  check?: (workspaceDir: string) => Promise<boolean>;
}

/** A benchmark: a named set of instances plus its dataset provenance. */
export interface BenchAdapter {
  name: string;
  datasetSplit: string;
  instances(): BenchInstance[];
}

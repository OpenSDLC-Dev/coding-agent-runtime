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

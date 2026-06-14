// Local-check scorer: runs the instance's own `check` against the post-turn workspace. This is the
// real scorer for the in-repo hello-bench walking skeleton (no Docker, no network). A thrown check
// (e.g. the agent left the file un-importable) counts as unresolved, never as a harness crash.

import type { BenchInstance } from "../types.js";
import type { ScoreContext, Scorer, Verdict } from "./types.js";

export const localCheckScorer: Scorer = {
  async score(instance: BenchInstance, ctx: ScoreContext): Promise<Verdict> {
    if (!instance.check) {
      return { resolved: false, detail: "instance has no local check" };
    }
    try {
      const resolved = await instance.check(ctx.workspaceDir);
      return { resolved };
    } catch (err) {
      return { resolved: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

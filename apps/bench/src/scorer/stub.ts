// Stub scorer: returns canned verdicts keyed by instance id. Used by every harness unit test (and
// the cheap CI gate) so the pipeline can be exercised end-to-end without running any real check.

import type { BenchInstance } from "../types.js";
import type { Scorer, Verdict } from "./types.js";

export function stubScorer(verdicts: Record<string, Verdict>): Scorer {
  return {
    async score(instance: BenchInstance): Promise<Verdict> {
      return verdicts[instance.id] ?? { resolved: false, detail: "no stub verdict" };
    },
  };
}

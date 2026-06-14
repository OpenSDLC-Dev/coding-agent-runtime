// The SWE-bench adapter. It composes the pieces: read the operator's local dataset file + the
// committed curated id-list, select the subset, and yield BenchInstances whose prepare() clones the
// repo at base_commit (the new workspace seam) and whose prompt withholds the oracle. The repo commits
// only the id-list (subsets/swebench-lite-curated.json) — never the issue text or gold patches — so
// the full records come from the operator's downloaded dataset at run time.
//
// Dataset loading is async, so it lives in BenchAdapter.load(), which the runner awaits before
// instances(). gitClone is injected so unit tests never touch git or the network.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { BenchAdapter, BenchInstance } from "../../types.js";
import { parseDataset, selectSubset } from "./dataset.js";
import type { GitClone } from "./git.js";
import { buildPrompt } from "./prompt.js";

export interface SweBenchConfig {
  /** Path to the operator-downloaded dataset JSON (full records). */
  datasetFile: string;
  /** Path to the committed curated instance-id list (JSON array of strings). */
  subsetFile: string;
  /** Reported as the dataset split / provenance, e.g. "lite-curated". */
  datasetSplit: string;
}

// A non-empty list of unique instance ids. Duplicates are rejected (not silently kept) so a malformed
// curated list fails loudly at load, the same way a missing id does — rather than skewing the run.
const SubsetSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "curated subset has duplicate instance ids");

export function createSweBenchAdapter(
  cfg: SweBenchConfig,
  deps: { gitClone: GitClone },
): BenchAdapter {
  let loaded: BenchInstance[] | null = null;

  return {
    name: "swe-bench",
    datasetSplit: cfg.datasetSplit,
    async load(): Promise<void> {
      const [datasetText, subsetText] = await Promise.all([
        readFile(cfg.datasetFile, "utf8"),
        readFile(cfg.subsetFile, "utf8"),
      ]);
      const ids = SubsetSchema.parse(JSON.parse(subsetText));
      const selected = selectSubset(parseDataset(datasetText), ids);
      loaded = selected.map((inst) => ({
        id: inst.instance_id,
        prompt: buildPrompt(inst),
        seedFiles: {},
        prepare: (workspaceDir) => deps.gitClone(inst.repo, inst.base_commit, workspaceDir),
      }));
    },
    instances(): BenchInstance[] {
      if (!loaded) {
        throw new Error("swe-bench adapter used before load(); the runner must await load() first");
      }
      return loaded;
    },
  };
}

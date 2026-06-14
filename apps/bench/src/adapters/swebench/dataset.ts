// Parse the operator-downloaded SWE-bench dataset file (a JSON array of instance records) into the
// few fields this harness actually consumes. The authoritative grader (the local swebench Docker
// harness, invoked via --dataset_name) reads FAIL_TO_PASS / PASS_TO_PASS / test_patch / version etc.
// itself, so the adapter only needs what it uses to clone the repo and build the prompt:
// instance_id, repo, base_commit, problem_statement. zod strips the other columns, so the same file
// can be passed verbatim to both this harness and the Docker grader.
//
// The string fields that flow into a child process (instance_id, repo, base_commit) are charset- and
// shape-validated here so a malformed/hostile dataset row can never reach `git` as an injectable
// argument. zod is the single source of truth, matching the runtime + report conventions.

import { z } from "zod";

export const SweInstanceSchema = z.object({
  // owner__repo-PR (e.g. astropy__astropy-12907); used verbatim as the prediction + report key.
  instance_id: z.string().regex(/^[A-Za-z0-9._-]+$/, "instance_id has unexpected characters"),
  // owner/name (e.g. django/django); interpolated into the clone URL, so keep it to a safe charset.
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "repo must be owner/name"),
  // a 40-char lowercase-hex commit SHA; checked out as a git argument.
  base_commit: z.string().regex(/^[0-9a-f]{40}$/, "base_commit must be a 40-char hex sha"),
  problem_statement: z.string().min(1),
});
export type SweInstance = z.infer<typeof SweInstanceSchema>;

export const SweDatasetSchema = z.array(SweInstanceSchema);

/** Parse already-read dataset text. Pure (no fs), so tests pass fixture strings directly. */
export function parseDataset(json: string): SweInstance[] {
  const raw: unknown = JSON.parse(json);
  return SweDatasetSchema.parse(raw);
}

/** Select + order the curated subset by instance_id. Throws on any id absent from the dataset so a
 *  stale curated list fails loudly rather than silently shrinking the run. */
export function selectSubset(all: SweInstance[], ids: string[]): SweInstance[] {
  const byId = new Map(all.map((i) => [i.instance_id, i]));
  return ids.map((id) => {
    const found = byId.get(id);
    if (!found) {
      throw new Error(`curated instance_id not found in dataset: ${id}`);
    }
    return found;
  });
}

// Capture the agent's solution as a SWE-bench prediction and write the predictions file.
//
// model_patch is the agent's changes as a unified diff. We stage everything (`git add -A`) and diff
// the index against the pinned base ref (`git diff --cached <BASE_REF>`), NOT against HEAD: diffing
// against a fixed base ref captures the change even if the agent committed its work during the turn
// (the staged-vs-HEAD recipe would return an empty patch in that case, silently scoring a real fix as
// unresolved). We do NOT strip test-file edits here — the grader resets test files to base before
// applying its own test_patch, so any test edits the agent made are ignored at scoring time anyway.
//
// git runs behind an injectable Exec seam so unit tests exercise the recipe with a fake (zero git).

import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Prediction } from "../../scorer/types.js";
import { BASE_REF } from "./git.js";

export const PredictionSchema = z.object({
  instance_id: z.string(),
  model_name_or_path: z.string(),
  model_patch: z.string(),
});

export type Exec = (file: string, args: string[], cwd: string) => Promise<{ stdout: string }>;

/** Collect model_patch: `git add -A` then `git diff --cached <BASE_REF>` (the base commit, pinned at
 *  clone time), so committed and uncommitted changes alike are captured. */
export async function collectModelPatch(workspaceDir: string, exec: Exec): Promise<string> {
  await exec("git", ["add", "-A"], workspaceDir);
  const { stdout } = await exec("git", ["diff", "--cached", BASE_REF], workspaceDir);
  return stdout;
}

/** Write predictions as the flat-list JSON form ([{instance_id, model_name_or_path, model_patch}]),
 *  which both the local swebench harness and sb-cli accept. Validates each record on the way out. */
export async function writePredictions(path: string, predictions: Prediction[]): Promise<void> {
  const validated = z.array(PredictionSchema).parse(predictions);
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

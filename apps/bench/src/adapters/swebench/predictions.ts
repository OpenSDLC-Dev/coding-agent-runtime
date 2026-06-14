// Capture the agent's solution as a SWE-bench prediction and write the predictions file.
//
// model_patch is the staged working-tree diff against the instance's base commit, collected exactly
// the way SWE-agent's submit step does it: `git add -A` then `git diff --cached`. After checkout the
// repo's HEAD is the base commit, so the cached diff is precisely the agent's changes. We do NOT strip
// test-file edits here — the grader resets test files to base before applying its own test_patch, so
// any test edits the agent made are ignored at scoring time anyway.
//
// git runs behind an injectable Exec seam so unit tests exercise the recipe with a fake (zero git).

import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Prediction } from "../../scorer/types.js";

export const PredictionSchema = z.object({
  instance_id: z.string(),
  model_name_or_path: z.string(),
  model_patch: z.string(),
});

export type Exec = (file: string, args: string[], cwd: string) => Promise<{ stdout: string }>;

/** Collect model_patch = `git diff --cached` after `git add -A`, relative to the base commit (HEAD). */
export async function collectModelPatch(workspaceDir: string, exec: Exec): Promise<string> {
  await exec("git", ["add", "-A"], workspaceDir);
  const { stdout } = await exec("git", ["diff", "--cached"], workspaceDir);
  return stdout;
}

/** Write predictions as the flat-list JSON form ([{instance_id, model_name_or_path, model_patch}]),
 *  which both the local swebench harness and sb-cli accept. Validates each record on the way out. */
export async function writePredictions(path: string, predictions: Prediction[]): Promise<void> {
  const validated = z.array(PredictionSchema).parse(predictions);
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

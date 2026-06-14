// Authoritative offline scorer: the official local SWE-bench harness (`python -m
// swebench.harness.run_evaluation`), which builds per-instance Docker images and runs each instance's
// FAIL_TO_PASS + PASS_TO_PASS tests. We never re-implement scoring; we write the predictions file,
// invoke the harness once over the whole run, and read its summary report — so our numbers are
// directly comparable to the public leaderboard.
//
// The harness summary report (make_run_report in swebench/harness/reporting.py, schema_version 2)
// carries exact per-instance id lists, which is what lets us attribute a verdict to each instance. The
// report PARSING (parseDockerReport / verdictFor) is pure and unit-tested against a fixture; the
// shell-out (runEval) and Docker are injected, so no test needs python or Docker.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writePredictions } from "../adapters/swebench/predictions.js";
import { run } from "../exec.js";
import type { BatchScorer, BatchVerdict, Prediction } from "./types.js";

// Exact shape of <model>.<run_id>.json from swebench/harness/reporting.py (schema_version 2).
export const SwebenchDockerReportSchema = z.object({
  total_instances: z.number(),
  submitted_instances: z.number(),
  completed_instances: z.number(),
  resolved_instances: z.number(),
  unresolved_instances: z.number(),
  empty_patch_instances: z.number(),
  error_instances: z.number(),
  completed_ids: z.array(z.string()),
  incomplete_ids: z.array(z.string()),
  empty_patch_ids: z.array(z.string()),
  submitted_ids: z.array(z.string()),
  resolved_ids: z.array(z.string()),
  unresolved_ids: z.array(z.string()),
  error_ids: z.array(z.string()),
  schema_version: z.literal(2),
});
export type SwebenchDockerReport = z.infer<typeof SwebenchDockerReportSchema>;

export function parseDockerReport(json: string): SwebenchDockerReport {
  return SwebenchDockerReportSchema.parse(JSON.parse(json));
}

// Map one instance to a verdict from the report's id lists. empty_patch counts as unresolved (not
// errored): SWE-bench scores a no-op submission against you, the same as a wrong fix. A harness error,
// or an id missing from every list, is surfaced as errored so it is never silently counted as a fail.
export function verdictFor(report: SwebenchDockerReport, instanceId: string): BatchVerdict {
  if (report.resolved_ids.includes(instanceId)) return { resolved: true };
  if (report.unresolved_ids.includes(instanceId)) {
    return { resolved: false, detail: "tests failed" };
  }
  if (report.empty_patch_ids.includes(instanceId)) {
    return { resolved: false, detail: "empty patch" };
  }
  if (report.error_ids.includes(instanceId)) {
    return { resolved: false, errored: true, detail: "harness error" };
  }
  return { resolved: false, errored: true, detail: "instance missing from report" };
}

// runId and modelName both end up in the report filename `<model>.<run_id>.json`, so both are
// constrained to a charset that cannot contain a path separator or "..". modelName additionally
// permits "/" (org/model form), which is normalized to "__" exactly as the harness does.
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

export interface SwebenchDockerOptions {
  /** HuggingFace id or local dataset path passed to --dataset_name (the grader loads tests from it). */
  datasetName: string;
  /** Names the run + the harness log subdir. Constrained to a safe charset (it becomes a filename). */
  runId: string;
  /** Where we write the predictions JSON the harness reads. */
  predictionsPath: string;
  /** Working directory for the grader. The harness writes its summary report and logs/ tree relative
   *  to its CWD (the --report_dir flag does not relocate the summary report), so this is where we then
   *  read <model>.<run_id>.json from. */
  reportDir: string;
  /** model_name_or_path embedded in predictions; also the report-filename stem (slashes -> "__"). MUST
   *  equal the modelName stamped on the predictions (BatchConfig.modelName) or the computed report
   *  filename will not match what the harness wrote. */
  modelName: string;
  /** Optional dataset split forwarded as --split. */
  split?: string;
  /** Injectable harness invocation (args, cwd). Defaults to spawning python; fakes skip Docker. */
  runEval?: (args: string[], cwd: string) => Promise<void>;
}

const defaultRunEval = async (args: string[], cwd: string): Promise<void> => {
  await run("python", args, cwd);
};

export function createSwebenchDockerScorer(opts: SwebenchDockerOptions): BatchScorer {
  if (!RUN_ID_PATTERN.test(opts.runId)) {
    throw new Error(`run_id has unexpected characters: ${JSON.stringify(opts.runId)}`);
  }
  if (!MODEL_NAME_PATTERN.test(opts.modelName)) {
    throw new Error(`model name has unexpected characters: ${JSON.stringify(opts.modelName)}`);
  }
  const runEval = opts.runEval ?? defaultRunEval;

  return {
    async scoreAll(predictions: Prediction[]): Promise<Map<string, BatchVerdict>> {
      await writePredictions(opts.predictionsPath, predictions);
      const args = [
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        opts.datasetName,
        "--predictions_path",
        opts.predictionsPath,
        "--run_id",
        opts.runId,
        "--report_dir",
        opts.reportDir,
        ...(opts.split ? ["--split", opts.split] : []),
      ];
      await runEval(args, opts.reportDir);

      const reportFile = join(
        opts.reportDir,
        `${opts.modelName.replace(/\//g, "__")}.${opts.runId}.json`,
      );
      const report = parseDockerReport(await readFile(reportFile, "utf8"));
      const verdicts = new Map<string, BatchVerdict>();
      for (const prediction of predictions) {
        verdicts.set(prediction.instance_id, verdictFor(report, prediction.instance_id));
      }
      return verdicts;
    },
  };
}

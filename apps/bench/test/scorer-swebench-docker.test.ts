import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSwebenchDockerScorer,
  parseDockerReport,
  verdictFor,
} from "../src/scorer/swebench-docker.js";
import type { Prediction } from "../src/scorer/types.js";
import { SYNTHETIC_DOCKER_REPORT } from "./swebench-fixtures.js";

describe("swebench-docker report parsing", () => {
  it("parses the schema_version 2 summary report", () => {
    const report = parseDockerReport(SYNTHETIC_DOCKER_REPORT);
    expect(report.resolved_ids).toEqual(["acme__widget-101"]);
    expect(report.total_instances).toBe(2);
    expect(report.schema_version).toBe(2);
  });

  it("rejects a report whose schema_version is not 2", () => {
    const bad = JSON.stringify({ ...JSON.parse(SYNTHETIC_DOCKER_REPORT), schema_version: 1 });
    expect(() => parseDockerReport(bad)).toThrow();
  });

  it("rejects a report missing an id list", () => {
    const obj = JSON.parse(SYNTHETIC_DOCKER_REPORT);
    obj.resolved_ids = undefined;
    expect(() => parseDockerReport(JSON.stringify(obj))).toThrow();
  });

  it("maps each instance id to a verdict from the id lists", () => {
    const report = parseDockerReport(
      JSON.stringify({
        ...JSON.parse(SYNTHETIC_DOCKER_REPORT),
        resolved_ids: ["a"],
        unresolved_ids: ["b"],
        empty_patch_ids: ["c"],
        error_ids: ["d"],
      }),
    );
    expect(verdictFor(report, "a")).toEqual({ resolved: true });
    expect(verdictFor(report, "b")).toEqual({ resolved: false, detail: "tests failed" });
    expect(verdictFor(report, "c")).toEqual({ resolved: false, detail: "empty patch" });
    expect(verdictFor(report, "d")).toEqual({
      resolved: false,
      errored: true,
      detail: "harness error",
    });
    expect(verdictFor(report, "missing")).toEqual({
      resolved: false,
      errored: true,
      detail: "instance missing from report",
    });
  });
});

describe("createSwebenchDockerScorer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sweval-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const predictions: Prediction[] = [
    { instance_id: "acme__widget-101", model_name_or_path: "cr", model_patch: "diff1" },
    { instance_id: "acme__gadget-7", model_name_or_path: "cr", model_patch: "diff2" },
  ];

  it("writes predictions, invokes the harness, and maps the report to verdicts (no python/Docker)", async () => {
    let seenArgs: string[] | null = null;
    const scorer = createSwebenchDockerScorer({
      datasetName: "princeton-nlp/SWE-bench_Lite",
      runId: "run-1",
      predictionsPath: join(dir, "preds.json"),
      reportDir: dir,
      modelName: "cr",
      runEval: async (args, _cwd) => {
        seenArgs = args;
        // The harness would write <model>.<run_id>.json into reportDir; the fake does it directly.
        await writeFile(join(dir, "cr.run-1.json"), SYNTHETIC_DOCKER_REPORT, "utf8");
      },
    });

    const verdicts = await scorer.scoreAll(predictions);

    // predictions file was written for the harness to read.
    const written = JSON.parse(await readFile(join(dir, "preds.json"), "utf8"));
    expect(written).toHaveLength(2);
    // harness argv shape.
    expect(seenArgs).toEqual([
      "-m",
      "swebench.harness.run_evaluation",
      "--dataset_name",
      "princeton-nlp/SWE-bench_Lite",
      "--predictions_path",
      join(dir, "preds.json"),
      "--run_id",
      "run-1",
      "--report_dir",
      dir,
    ]);
    // verdicts attributed per id from the report.
    expect(verdicts.get("acme__widget-101")).toEqual({ resolved: true });
    expect(verdicts.get("acme__gadget-7")).toEqual({ resolved: false, detail: "tests failed" });
  });

  it("derives the report filename from a slashed model name", async () => {
    const scorer = createSwebenchDockerScorer({
      datasetName: "d",
      runId: "r",
      predictionsPath: join(dir, "p.json"),
      reportDir: dir,
      modelName: "org/model",
      runEval: async () => {
        await writeFile(join(dir, "org__model.r.json"), SYNTHETIC_DOCKER_REPORT, "utf8");
      },
    });
    const verdicts = await scorer.scoreAll(predictions);
    expect(verdicts.get("acme__widget-101")).toEqual({ resolved: true });
  });

  it("rejects an unsafe run_id at construction", () => {
    expect(() =>
      createSwebenchDockerScorer({
        datasetName: "d",
        runId: "../escape",
        predictionsPath: "p",
        reportDir: dir,
        modelName: "m",
      }),
    ).toThrow(/run_id/);
  });
});

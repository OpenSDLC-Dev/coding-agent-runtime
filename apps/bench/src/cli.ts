// CLI entrypoint: wire the real HTTP client + a benchmark adapter + a scorer, run the benchmark
// against a *running* runtime, print a summary, and optionally write the report JSON. Thin glue — all
// logic lives in the unit-tested modules.
//
// Two benchmarks:
//   - hello-bench: in-repo toy tasks, scored locally (no external data). The default.
//   - swe-bench:   SWE-bench Lite curated subset. Clones each repo at its base commit, drives a turn,
//                  collects the diff as a prediction, and scores the whole run with the offline
//                  swebench Docker harness (see docs/benchmarks.md for the operator prerequisites).

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helloBench } from "./adapters/hello-bench/index.js";
import { defaultGitClone } from "./adapters/swebench/git.js";
import { createSweBenchAdapter } from "./adapters/swebench/index.js";
import { collectModelPatch } from "./adapters/swebench/predictions.js";
import { run } from "./exec.js";
import type { RunReport } from "./report/schema.js";
import { runBenchmark } from "./runner.js";
import { localCheckScorer } from "./scorer/local-check.js";
import { createSwebenchDockerScorer } from "./scorer/swebench-docker.js";
import { createHttpClient } from "./sse-client.js";

// The committed curated id-list, resolved relative to this file so it works from src or dist.
const DEFAULT_SUBSET = fileURLToPath(
  new URL("../subsets/swebench-lite-curated.json", import.meta.url),
);

interface CliArgs {
  benchmark: string;
  baseUrl: string;
  workspace: string;
  model: string | undefined;
  out: string | undefined;
  // swe-bench only:
  dataset: string | undefined;
  subset: string;
  datasetName: string;
  split: string | undefined;
  runId: string;
  reportDir: string;
  modelName: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const model = get("model") ?? process.env.RUNTIME_DEFAULT_MODEL;
  const dataset = get("dataset") ?? process.env.RUNTIME_SWEBENCH_DATASET;
  return {
    benchmark: get("benchmark") ?? "hello-bench",
    baseUrl: (get("base-url") ?? process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(
      /\/$/,
      "",
    ),
    workspace: resolve(get("workspace") ?? process.env.RUNTIME_CWD ?? "./.bench-workspace"),
    model,
    out: get("out"),
    dataset,
    subset: resolve(get("subset") ?? DEFAULT_SUBSET),
    // Default the grader's --dataset_name to the SAME local file the adapter prompts from, so it scores
    // against the exact records the agent saw. Override with --dataset-name (e.g. a HuggingFace id).
    datasetName: get("dataset-name") ?? dataset ?? "princeton-nlp/SWE-bench_Lite",
    split: get("split"),
    runId: get("run-id") ?? `swe-bench-${Date.now()}`,
    reportDir: resolve(get("report-dir") ?? "./.bench-reports"),
    modelName: get("model-name") ?? model ?? "coding-agent-runtime",
  };
}

async function runSelected(
  args: CliArgs,
  client: ReturnType<typeof createHttpClient>,
): Promise<RunReport> {
  const common = {
    client,
    workspaceDir: args.workspace,
    model: args.model,
    log: (m: string): void => console.log(`[bench] ${m}`),
  };

  if (args.benchmark === "hello-bench") {
    return runBenchmark({ ...common, adapter: helloBench, scorer: localCheckScorer });
  }

  if (args.benchmark === "swe-bench") {
    if (!args.dataset) {
      throw new Error(
        "swe-bench needs the dataset file: pass --dataset <file> or set RUNTIME_SWEBENCH_DATASET " +
          "(see docs/benchmarks.md for how to download it)",
      );
    }
    await mkdir(args.reportDir, { recursive: true });
    const adapter = createSweBenchAdapter(
      { datasetFile: args.dataset, subsetFile: args.subset, datasetSplit: "lite-curated" },
      { gitClone: defaultGitClone },
    );
    const scorer = createSwebenchDockerScorer({
      datasetName: args.datasetName,
      runId: args.runId,
      predictionsPath: resolve(args.reportDir, "predictions.json"),
      reportDir: args.reportDir,
      modelName: args.modelName,
      split: args.split,
    });
    return runBenchmark({
      ...common,
      adapter,
      batch: {
        scorer,
        collectPatch: (ws) => collectModelPatch(ws, run),
        modelName: args.modelName,
      },
    });
  }

  throw new Error(`unknown benchmark: ${args.benchmark} (known: hello-bench, swe-bench)`);
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const client = createHttpClient({ baseUrl: args.baseUrl });
  console.log(`[bench] waiting for runtime at ${args.baseUrl} ...`);
  if (!(await client.health())) {
    throw new Error(`runtime not healthy at ${args.baseUrl}`);
  }

  console.log(`[bench] running ${args.benchmark} (workspace: ${args.workspace})`);
  const report = await runSelected(args, client);

  const { summary } = report;
  console.log(
    `[bench] ${report.benchmark}: ${summary.resolved}/${summary.total} resolved ` +
      `(${(summary.resolveRate * 100).toFixed(1)}%), ${summary.totalTurns} turns, ` +
      `$${summary.totalCostUsd.toFixed(4)}`,
  );

  if (args.out) {
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[bench] report written to ${args.out}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`[bench] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

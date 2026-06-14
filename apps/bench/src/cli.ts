// CLI entrypoint: wire the real HTTP client + a benchmark adapter + a scorer, run the benchmark
// against a *running* runtime, snapshot its config tuple, print a summary, and optionally write the
// report / compare against the committed baseline / accept a new baseline / append history / regenerate
// BENCHMARKS.md. Thin glue -- all logic lives in the unit-tested modules.
//
// Commands:
//   (default / run)   run a benchmark and apply the tracking flags below
//   emit-markdown     regenerate BENCHMARKS.md from the committed baselines (no runtime needed)
//
// Two benchmarks:
//   - hello-bench: in-repo toy tasks, scored locally (no external data). The default.
//   - swe-bench:   SWE-bench Lite curated subset, scored by the offline swebench Docker harness
//                  (see docs/benchmarks.md for the operator prerequisites).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helloBench } from "./adapters/hello-bench/index.js";
import { defaultGitClone } from "./adapters/swebench/git.js";
import { createSweBenchAdapter } from "./adapters/swebench/index.js";
import { collectModelPatch } from "./adapters/swebench/predictions.js";
import { baselineFromReport, loadAllBaselines, loadBaseline, writeBaseline } from "./baseline.js";
import { compare, exitCodeForVerdict } from "./compare.js";
import { baselineKey, buildSnapshot } from "./config-snapshot.js";
import { run } from "./exec.js";
import { appendHistory, historyEntryFromReport } from "./history.js";
import { renderBenchmarks } from "./report/markdown.js";
import type { RunReport } from "./report/schema.js";
import { type BatchConfig, runBenchmark } from "./runner.js";
import { localCheckScorer } from "./scorer/local-check.js";
import { createSwebenchDockerScorer } from "./scorer/swebench-docker.js";
import { createHttpClient } from "./sse-client.js";
import type { BenchAdapter } from "./types.js";

// Paths resolved relative to this file so they work from src or dist.
const DEFAULT_SUBSET = fileURLToPath(
  new URL("../subsets/swebench-lite-curated.json", import.meta.url),
);
const DEFAULT_BASELINE_DIR = fileURLToPath(new URL("../baselines", import.meta.url));
const DEFAULT_HISTORY_DIR = fileURLToPath(new URL("../history", import.meta.url));
const DEFAULT_BENCHMARKS_OUT = fileURLToPath(new URL("../../../BENCHMARKS.md", import.meta.url));

export interface CliArgs {
  command: string;
  benchmark: string;
  baseUrl: string;
  workspace: string;
  model: string | undefined;
  out: string | undefined;
  // config tuple / tracking:
  backendLabel: string;
  baselineDir: string;
  historyDir: string;
  benchmarksOut: string;
  compare: boolean;
  accept: boolean;
  updateHistory: boolean;
  emitMarkdown: boolean;
  // swe-bench only:
  dataset: string | undefined;
  subset: string;
  datasetName: string;
  split: string | undefined;
  runId: string;
  reportDir: string;
  modelName: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  // The leading "--" that pnpm/npm forwards (scripts/bench.mjs adds one) can land as argv[0]; skip it
  // so a bare command like `emit-markdown` is still recognized. Flag lookups search by name, unaffected.
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  const command = tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : "run";
  const model = get("model") ?? process.env.RUNTIME_DEFAULT_MODEL;
  const dataset = get("dataset") ?? process.env.RUNTIME_SWEBENCH_DATASET;
  return {
    command,
    benchmark: get("benchmark") ?? "hello-bench",
    baseUrl: (get("base-url") ?? process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(
      /\/$/,
      "",
    ),
    workspace: resolve(get("workspace") ?? process.env.RUNTIME_CWD ?? "./.bench-workspace"),
    model,
    out: get("out"),
    backendLabel: get("backend-label") ?? process.env.BENCH_BACKEND_LABEL ?? "unknown",
    baselineDir: resolve(get("baseline-dir") ?? DEFAULT_BASELINE_DIR),
    historyDir: resolve(get("history-dir") ?? DEFAULT_HISTORY_DIR),
    benchmarksOut: resolve(get("benchmarks-out") ?? DEFAULT_BENCHMARKS_OUT),
    compare: has("compare"),
    accept: has("accept"),
    updateHistory: has("update-history"),
    emitMarkdown: has("emit-markdown"),
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

async function harnessVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

// Build the adapter and scoring config for the selected benchmark, without running it yet.
async function buildBenchmark(
  args: CliArgs,
): Promise<{ adapter: BenchAdapter; scorer?: typeof localCheckScorer; batch?: BatchConfig }> {
  if (args.benchmark === "hello-bench") {
    return { adapter: helloBench, scorer: localCheckScorer };
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
    return {
      adapter,
      batch: {
        scorer,
        collectPatch: (ws) => collectModelPatch(ws, run),
        modelName: args.modelName,
      },
    };
  }
  throw new Error(`unknown benchmark: ${args.benchmark} (known: hello-bench, swe-bench)`);
}

export async function emitMarkdown(args: CliArgs): Promise<void> {
  const md = renderBenchmarks(await loadAllBaselines(args.baselineDir));
  await writeFile(args.benchmarksOut, md, "utf8");
  console.log(`[bench] wrote ${args.benchmarksOut}`);
}

// Apply the post-run tracking flags (history / accept / compare / emit-markdown) and return the
// process exit code: non-zero only when --compare finds a regression. Pure I/O over the committed
// dirs + the report, so it is unit-testable with a tmp dir and a synthetic report.
export async function applyTracking(report: RunReport, args: CliArgs): Promise<number> {
  const key = baselineKey(report.config);
  let exitCode = 0;
  if (args.updateHistory) {
    await appendHistory(args.historyDir, historyEntryFromReport(report, report.finishedAt));
    console.log(`[bench] appended history for ${key}`);
  }
  if (args.accept) {
    await writeBaseline(args.baselineDir, baselineFromReport(report, report.finishedAt));
    console.log(`[bench] accepted baseline ${key}`);
  }
  if (args.compare) {
    const result = compare(await loadBaseline(args.baselineDir, key), report);
    console.log(`[bench] compare: ${result.verdict.toUpperCase()} -- ${result.detail}`);
    exitCode = exitCodeForVerdict(result.verdict);
  }
  if (args.emitMarkdown) {
    await emitMarkdown(args);
  }
  return exitCode;
}

async function runCommand(args: CliArgs): Promise<void> {
  const client = createHttpClient({ baseUrl: args.baseUrl });
  console.log(`[bench] waiting for runtime at ${args.baseUrl} ...`);
  if (!(await client.health())) {
    throw new Error(`runtime not healthy at ${args.baseUrl}`);
  }

  const { adapter, scorer, batch } = await buildBenchmark(args);
  // Snapshot the config tuple: load the adapter (so instances() is ready), read the instance ids and
  // the runtime's /config, and resolve the model that will actually run.
  await adapter.load?.();
  const rtConfig = await client.getConfig();
  const snapshot = buildSnapshot({
    benchmark: adapter.name,
    datasetSplit: adapter.datasetSplit,
    instanceIds: adapter.instances().map((i) => i.id),
    backendLabel: args.backendLabel,
    model: args.model ?? rtConfig.defaultModel ?? "default",
    config: rtConfig,
    harnessVersion: await harnessVersion(),
  });
  const key = baselineKey(snapshot);

  console.log(
    `[bench] running ${adapter.name} (workspace: ${args.workspace}); baseline key ${key}`,
  );
  const report: RunReport = await runBenchmark({
    client,
    workspaceDir: args.workspace,
    model: args.model,
    log: (m: string): void => console.log(`[bench] ${m}`),
    adapter,
    config: snapshot,
    ...(batch ? { batch } : { scorer }),
  });

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
  process.exitCode = await applyTracking(report, args);
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "emit-markdown") {
    await emitMarkdown(args);
    return;
  }
  await runCommand(args);
}

// Run main() only when executed as the entry point (tsx src/cli.ts / node dist/cli.js), not when a
// test imports the exported helpers above -- otherwise importing the module would kick off a real run.
const argv1 = process.argv[1];
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[bench] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

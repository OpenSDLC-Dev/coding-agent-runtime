// CLI entrypoint: wire the real HTTP client + a benchmark adapter + the local-check scorer, run the
// benchmark against a *running* runtime, print a summary, and optionally write the report JSON.
// Thin glue — all logic lives in the unit-tested modules.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { helloBench } from "./adapters/hello-bench/index.js";
import { runBenchmark } from "./runner.js";
import { localCheckScorer } from "./scorer/local-check.js";
import { createHttpClient } from "./sse-client.js";
import type { BenchAdapter } from "./types.js";

const ADAPTERS: Record<string, BenchAdapter> = {
  "hello-bench": helloBench,
};

interface CliArgs {
  benchmark: string;
  baseUrl: string;
  workspace: string;
  model: string | undefined;
  out: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    benchmark: get("benchmark") ?? "hello-bench",
    baseUrl: (get("base-url") ?? process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(
      /\/$/,
      "",
    ),
    workspace: resolve(get("workspace") ?? process.env.RUNTIME_CWD ?? "./.bench-workspace"),
    model: get("model") ?? process.env.RUNTIME_DEFAULT_MODEL,
    out: get("out"),
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const adapter = ADAPTERS[args.benchmark];
  if (!adapter) {
    throw new Error(
      `unknown benchmark: ${args.benchmark} (known: ${Object.keys(ADAPTERS).join(", ")})`,
    );
  }

  const client = createHttpClient({ baseUrl: args.baseUrl });
  console.log(`[bench] waiting for runtime at ${args.baseUrl} ...`);
  if (!(await client.health())) {
    throw new Error(`runtime not healthy at ${args.baseUrl}`);
  }

  console.log(`[bench] running ${adapter.name} (workspace: ${args.workspace})`);
  const report = await runBenchmark({
    adapter,
    client,
    scorer: localCheckScorer,
    workspaceDir: args.workspace,
    model: args.model,
    log: (m) => console.log(`[bench] ${m}`),
  });

  const { summary } = report;
  console.log(
    `[bench] ${adapter.name}: ${summary.resolved}/${summary.total} resolved ` +
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

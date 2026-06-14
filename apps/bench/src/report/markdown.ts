// Render the committed baselines into BENCHMARKS.md. Pure and deterministic: no clock, no environment,
// stable ordering -- so regenerating from the same baselines always yields byte-identical output (a
// drift check can diff it in CI without flakiness).

import type { Baseline } from "../baseline.js";

const GENERATED_NOTE =
  "<!-- Generated from apps/bench/baselines/ by `node scripts/bench.mjs emit-markdown`. Do not edit by hand. -->";

function rate(b: Baseline): string {
  const { resolveRate, resolved, total } = b.summary;
  return `${(resolveRate * 100).toFixed(1)}% (${resolved}/${total})`;
}

export function renderBenchmarks(baselines: readonly Baseline[]): string {
  const lines = ["# Benchmarks", "", GENERATED_NOTE, ""];

  if (baselines.length === 0) {
    lines.push(
      "_No accepted baselines yet._",
      "",
      "Run a benchmark against a runtime and accept the result as a baseline:",
      "",
      "```",
      "node scripts/bench.mjs --benchmark hello-bench --backend-label <name> --accept --emit-markdown",
      "```",
      "",
      "See [docs/benchmarks.md](docs/benchmarks.md) for the full workflow.",
      "",
    );
    return `${lines.join("\n")}`;
  }

  lines.push(
    "| Benchmark | Split | Backend | Model | Effort | Max turns | Scaffold | Resolve rate | Runtime | Key |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  const sorted = [...baselines].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const b of sorted) {
    const c = b.config;
    lines.push(
      `| ${c.benchmark} | ${c.datasetSplit} | ${c.backendLabel} | ${c.model} | ${c.effort} | ` +
        `${c.maxTurns} | ${c.promptScaffoldVersion} | ${rate(b)} | ${c.runtimeVersion} | \`${b.key}\` |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

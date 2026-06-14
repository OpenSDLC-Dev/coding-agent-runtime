#!/usr/bin/env node
// Convenience entrypoint for the benchmark harness against a *running* runtime — the documented
// sibling of scripts/smoke.mjs. It forwards to the @app/bench CLI through the workspace toolchain
// (tsx) so it runs straight from TypeScript source without a prior build.
//
// Usage:
//   node scripts/bench.mjs --benchmark hello-bench --base-url http://127.0.0.1:8080
//   node scripts/bench.mjs --benchmark hello-bench --workspace /path/to/RUNTIME_CWD --out report.json
//   node scripts/bench.mjs --benchmark swe-bench   --dataset swe-bench-lite.json --out report.json
//
// Baseline / regression tracking (both benchmarks; see docs/benchmarks.md):
//   node scripts/bench.mjs --benchmark hello-bench --backend-label minimax-m3 --accept --emit-markdown
//   node scripts/bench.mjs --benchmark hello-bench --backend-label minimax-m3 --compare --update-history
//   node scripts/bench.mjs emit-markdown      # regenerate BENCHMARKS.md from committed baselines (no runtime)
//
// WARNING: --workspace (default ./.bench-workspace, or RUNTIME_CWD) is emptied between instances.
// Point it at a dedicated directory that mirrors the runtime's RUNTIME_CWD — never a repo checkout
// (a .git entry is refused as a safety net). The runtime under test holds the API key/backend
// config; this script never needs them.
//
// The swe-bench benchmark needs git + a downloaded dataset file + python/Docker/swebench for scoring;
// see docs/benchmarks.md for the prerequisites and flags.

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const child = spawn(
  "corepack",
  ["pnpm", "--filter", "@app/bench", "run", "bench:dev", "--", ...args],
  { stdio: "inherit", shell: process.platform === "win32" },
);

child.on("error", (err) => {
  console.error(`[bench] failed to launch: ${err.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

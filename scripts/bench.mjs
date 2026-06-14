#!/usr/bin/env node
// Convenience entrypoint for the benchmark harness against a *running* runtime — the documented
// sibling of scripts/smoke.mjs. It forwards to the @app/bench CLI through the workspace toolchain
// (tsx) so it runs straight from TypeScript source without a prior build.
//
// Usage:
//   node scripts/bench.mjs --benchmark hello-bench --base-url http://127.0.0.1:8080
//   node scripts/bench.mjs --benchmark hello-bench --workspace /path/to/RUNTIME_CWD --out report.json
//
// The runtime under test holds the API key/backend config; this script never needs them.

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

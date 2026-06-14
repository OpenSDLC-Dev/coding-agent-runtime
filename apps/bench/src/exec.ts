// The single place the harness spawns external processes (git, python). Every call goes through
// spawn(file, args[], { shell: false }) so an argument is NEVER interpreted by a shell — there is no
// command-injection surface even though some inputs (repo, base_commit, run_id) originate from a
// dataset file. This `run` is the default real implementation; unit tests inject fakes instead and
// never spawn anything, so it is intentionally not exercised in the test suite (like the default
// fetch in sse-client.ts).

import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
}

/** Run a command, capturing stdout. Rejects on non-zero exit or spawn failure. shell is always off. */
export function run(file: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
      } else {
        reject(new Error(`${file} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

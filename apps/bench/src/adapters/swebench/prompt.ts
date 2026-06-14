// Build the agent-facing task prompt from a SWE-bench instance. This encodes the SWE-bench contract:
// the agent is given ONLY the issue text (problem_statement) plus the repo already checked out at
// base_commit. The gold patch, the test_patch, and hints_text are deliberately withheld — including
// any of them would leak the oracle and make a score incomparable to the public leaderboard (whose
// "no hints" runs are the standard). Pure + side-effect-free, so it is trivially snapshot-testable.

import type { SweInstance } from "./dataset.js";

export function buildPrompt(inst: SweInstance): string {
  return [
    `You are working in a clean checkout of ${inst.repo} at commit ${inst.base_commit}, which is the`,
    "current working directory. Resolve the GitHub issue below by editing the repository's source",
    "files in place. Do not edit, add, or delete test files — the grader supplies its own tests and",
    "any changes you make to tests are discarded before grading. Make the smallest change that fixes",
    "the issue.",
    "",
    "--- ISSUE ---",
    inst.problem_statement,
  ].join("\n");
}

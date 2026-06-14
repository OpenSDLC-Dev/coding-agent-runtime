// Default repo materialization for the SWE-bench adapter: produce a working tree of `repo` at
// `base_commit` in the workspace, with HEAD = base_commit so a later `git diff --cached` yields exactly
// the agent's changes. Mirrors SWE-agent's approach — a shallow single-commit fetch by SHA (GitHub
// serves these) rather than a full clone, to keep big repos cheap. Every git call goes through `run`
// (spawn, shell off), and repo/base_commit were charset-validated by the dataset schema, so there is
// no injection surface. This is real-run-only; unit tests inject a fake GitClone instead.

import { run } from "../../exec.js";

export type GitClone = (repo: string, baseCommit: string, workspaceDir: string) => Promise<void>;

// A fixed ref pinned at the base commit. The prediction is diffed against THIS ref, not HEAD, so the
// patch is captured even if the agent commits its work during the turn (`git` is in the runtime's Bash
// allowlist, so `git commit` is allowed). A ref outside refs/heads is unlikely to be touched by the
// agent's own git usage.
export const BASE_REF = "refs/bench/base";

export const defaultGitClone: GitClone = async (repo, baseCommit, workspaceDir) => {
  const url = `https://github.com/${repo}.git`;
  await run("git", ["init", "-q"], workspaceDir);
  await run("git", ["remote", "add", "origin", url], workspaceDir);
  await run("git", ["fetch", "-q", "--depth", "1", "origin", baseCommit], workspaceDir);
  await run("git", ["checkout", "-q", baseCommit], workspaceDir);
  await run("git", ["update-ref", BASE_REF, baseCommit], workspaceDir);
};

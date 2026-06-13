# Contributing

How we ship changes to `coding-agent-runtime`. The loop below is also encoded as composable
Claude Code skills under `.claude/skills/coding-agent-runtime-*` — a human can follow this doc,
and an agent can run `coding-agent-runtime-delivery-workflow`, which orchestrates the rest.

## Prerequisites

- Node.js 22+ and pnpm via Corepack: run `corepack enable` once (the repo pins the pnpm version
  in `package.json`). The scripts below call `pnpm` directly; if it is not on your PATH, prefix
  with `corepack ` (e.g. `corepack pnpm verify`).
- Install dependencies once before running anything else: `pnpm install --frozen-lockfile`.
- A `.env` at the repo root for turns that hit a model backend (see `.env.example`).

## The loop

1. **Plan** (`coding-agent-runtime-plan`) — state assumptions, define verifiable success
   criteria, and derive a TDD test list before writing code.
2. **Implement with TDD** (`coding-agent-runtime-tdd`) — red → green → refactor. Runtime tests
   live in `apps/runtime/test/`; inject a fake SDK via `fakeQueryFn` / `sampleMessages`
   (`apps/runtime/test/helpers.ts`) instead of calling a real model.
3. **Verify in-loop:**
   - **Deterministic gate (always):** `pnpm verify` — Biome CI + recursive typecheck, test, and
     build. This mirrors the required CI jobs.
   - **Runtime end-to-end** (`coding-agent-runtime-verify-runtime`) — when request / SSE / SDK
     behavior changed: start the runtime (`pnpm --filter @app/runtime dev`) and run
     `node scripts/smoke.mjs` (polls `/healthz`, runs one real turn, asserts `init` + `result`).
   - **Web** (`coding-agent-runtime-verify-web`) — for UI changes: drive the playground in a real
     browser (`pnpm --filter @app/web dev`, then the Claude-in-Chrome MCP) and check the console.
4. **Keep docs in step** — if the change alters the architecture, deployment, security posture, or
   workflow, update the **Project Snapshot** in `CLAUDE.md` and the `[Unreleased]` section of
   `CHANGELOG.md` in the *same* PR.
5. **Open a PR** — never push to `main`. Branch → commit → push → `gh pr create`. Fill in the PR
   template checklist.
6. **Pre-merge review** (`coding-agent-runtime-code-review`) — have an agent that did *not* write
   the change review the diff. For large or high-risk diffs, also run `/code-review ultra`.
7. **Babysit CI** — `gh pr checks <n> --watch`; fix failures until green. Required contexts:
   `lint`, `verify` (Node 22 + 24), `docker`, `audit`. `smoke` (one real turn) is not required.
8. **Squash merge** — `gh pr merge <n> --squash --delete-branch`, then `git switch main &&
   git pull --ff-only`.

## Hard rules

- **Never push to `main`.** Feature branch → PR → CI → **squash** merge only.
- **English** for everything published to the repository (Markdown docs, code comments, commit
  messages, the repo description).
- **Simplicity first; surgical changes** — every changed line should trace to the request. See
  `CLAUDE.md` for the full guidelines.

## Release naming

When cutting a tagged release from `main`:

- **Git tag:** the bare semver `vX.Y.Z` (annotated), e.g. `v0.6.0`. Git tag names cannot contain
  spaces, so the tag ref stays unprefixed.
- **GitHub Release title:** `coding-agent-runtime vX.Y.Z` — the project-prefixed, space-bearing
  name lives in the release title, not the tag ref. An optional ` — <theme>` suffix is allowed,
  e.g. `coding-agent-runtime v0.6.0 — Hosting production guards`.

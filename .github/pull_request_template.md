<!-- See CONTRIBUTING.md for the full plan → TDD → verify → review → PR → squash workflow. -->

## What & why

<!-- What does this change do, and why? Link any related issue. -->

## How it was verified

<!-- Commands run, tests added, manual/browser checks. -->

## Checklist

- [ ] `pnpm verify` is green (Biome + typecheck + test + build)
- [ ] Ran a real-turn smoke (`node scripts/smoke.mjs`) if request / SSE / SDK behavior changed
- [ ] Verified the UI in a browser (`coding-agent-runtime-verify-web`) if `apps/web` changed
- [ ] Updated the `CLAUDE.md` Project Snapshot and `CHANGELOG.md` `[Unreleased]` if this alters architecture, deployment, security, or workflow
- [ ] Pre-merge review done (`coding-agent-runtime-code-review`; `/code-review ultra` for large or high-risk diffs)
- [ ] All repo-published artifacts are in English

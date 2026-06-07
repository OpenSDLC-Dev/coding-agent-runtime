---
name: coding-agent-runtime-delivery-workflow
description: Use to take a change in coding-agent-runtime from idea to merged. Orchestrates plan, TDD, in-loop verification, pre-merge review, PR, CI babysitting, and squash merge, enforcing the repo's hard workflow rules.
---

# Delivery workflow

The end-to-end loop for shipping a change. It bundles the other `coding-agent-runtime-*` skills
and encodes CLAUDE.md's hard rules. Use judgment on trivial edits, but never skip the
branch → PR → CI → squash flow.

## Phases

1. **Plan** — run `coding-agent-runtime-plan`: assumptions, verifiable success criteria, a TDD
   test list, and expected scope.
2. **Implement (TDD)** — run `coding-agent-runtime-tdd`: red → green → refactor.
3. **Verify in-loop** — route by what changed:
   - touched `apps/runtime/**` → `coding-agent-runtime-verify-runtime`
   - touched `apps/web/**` → `coding-agent-runtime-verify-web`
   - at minimum, always run `pnpm verify`.
4. **Simplify** — converge the diff (CLAUDE.md §2/§3). Use `/simplify` if available, else
   self-review; every changed line must trace to the request.
5. **Maintenance gate** — if the change alters architecture, deployment, security posture, or
   workflow, update the CLAUDE.md **Project Snapshot** AND the CHANGELOG `[Unreleased]` section
   in the SAME change. Confirm all repo-published artifacts are English (CLAUDE.md §5).
6. **Open the PR** — branch guard: NEVER commit on `main`; if you are on `main`, create a
   feature branch first. Commit with `git commit -m ...` (avoid an editor / UTF-8 BOM), push,
   and `gh pr create` with a clear what / why / verification body.
7. **Pre-merge review** — run `coding-agent-runtime-code-review` on the branch diff; fix every
   BLOCKER and SHOULD-FIX it surfaces.
8. **Babysit CI** — `gh pr checks <n> --watch`; fix any failing job and push until all required
   contexts are green: `lint`, `verify` (Node 22 + 24), `docker`, `audit`. `smoke` is not a
   required context, but investigate it if it fails for a real reason.
9. **Squash merge** — once CI is green, the review is clean, and the user approves:
   `gh pr merge <n> --squash --delete-branch`, then `git switch main && git pull --ff-only`.

## Hard rules (from CLAUDE.md)

- Never push to `main` directly — feature branch → PR → CI → **squash** merge only.
- English for everything published to the repository.
- Simplicity first; surgical changes; every changed line traces to the request.

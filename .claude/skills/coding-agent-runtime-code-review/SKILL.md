---
name: coding-agent-runtime-code-review
description: Use before merging a PR in coding-agent-runtime. Spawns a fresh, context-isolated agent to review the branch diff against main with no knowledge of how the change was written.
---

# Pre-merge code review

Get an independent review from an agent that did *not* write the code, before squash-merging.
A fresh agent carries none of the author's biases and catches what the first pass missed.

## Steps

1. **Spawn a fresh sub-agent** with the Agent tool (`subagent_type: general-purpose`, or
   `Explore` for a read-only pass). Give it NO context about how the change was made — only the
   review task. Tell it explicitly: "You did not write this code and have no prior context."
2. **Have it read the diff itself:** `git diff main...HEAD` (or `git diff main...<branch>`), and
   review against these dimensions:
   - **Correctness** and edge cases — does it do what it claims?
   - **Security / trust model** — the agent runs in bypass-permissions; guardrails are the
     parser-based Bash allowlist (+ `disallowedTools`) and container hardening; there is no
     inbound auth by design. Flag anything that weakens these.
   - **Scope discipline** (CLAUDE.md §3) — every changed line traces to the stated purpose; no
     unrelated edits or dead code.
   - **Tests** — new behavior is covered (TDD); existing tests still hold.
   - **Docs** — CHANGELOG `[Unreleased]` and the CLAUDE.md Project Snapshot are updated if the
     change warrants it; published artifacts are English (CLAUDE.md §5).
   Ask for findings grouped **BLOCKER / SHOULD-FIX / NIT**, each with file:line evidence, and an
   explicit "nothing material" verdict if it is clean. Tell it not to be sycophantic.
3. **Triage.** Fix BLOCKER and SHOULD-FIX before merge; record NITs.
4. **Deep review for risky changes.** For large, high-risk, or security-/architecture-touching
   diffs, additionally ask the user to run `/code-review ultra` — a deeper, user-triggered,
   billed multi-agent cloud review. It cannot be launched automatically; only the user can.

This skill is the pre-merge step of `coding-agent-runtime-delivery-workflow`.

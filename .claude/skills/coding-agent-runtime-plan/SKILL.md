---
name: coding-agent-runtime-plan
description: Use before implementing any non-trivial change in coding-agent-runtime. Turns a request into explicit assumptions, verifiable success criteria, and a concrete TDD test list before any code is written.
---

# Plan a change

Run this before writing code for anything beyond a trivial edit. Produce a short written
plan and do not start implementing until the success criteria and test list are clear.

## Steps

1. **State assumptions and interpretations** (CLAUDE.md §1). If multiple readings exist, list
   them and pick one explicitly. If something is genuinely unclear, stop and ask before coding.
2. **Define success criteria** (CLAUDE.md §4). Make them verifiable — e.g. "`POST /sessions`
   returns HTTP 429 when more than `RUNTIME_MAX_CONCURRENT_TURNS` turns are in flight", not
   "add concurrency limiting".
3. **Derive the TDD test list.** Translate each success criterion into one or more *failing*
   tests you will write first: name the test file and the assertion. For runtime/logic these
   are vitest cases (see `coding-agent-runtime-tdd`). For pure-UI work the in-loop check is a
   browser walkthrough (see `coding-agent-runtime-verify-web`), not a unit test — note that.
4. **Scope check** (CLAUDE.md §2/§3): pick the smallest change that satisfies the criteria, no
   speculative abstractions, and list the files you expect to touch.
5. **Decide if deeper planning is needed.** For large or cross-cutting work, use plan mode /
   brainstorming before proceeding.

Hand the plan + test list to `coding-agent-runtime-tdd`. This skill is normally invoked as the
first phase of `coding-agent-runtime-delivery-workflow`.

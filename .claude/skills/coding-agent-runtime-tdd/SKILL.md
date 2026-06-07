---
name: coding-agent-runtime-tdd
description: Use when implementing runtime or logic changes in coding-agent-runtime. Enforces red → green → refactor with vitest, writing the failing test first using the existing fakeQueryFn injection seam.
---

# TDD for the runtime

Red → green → refactor. Never write implementation before a failing test that pins the
behavior. Work from the test list produced by `coding-agent-runtime-plan`.

## Loop

1. **Red — write a failing test** in `apps/runtime/test/*.test.ts`. Reuse the existing seams
   instead of building new mocks:
   - Inject a fake SDK with `fakeQueryFn(messages)` / `sampleMessages` from
     `apps/runtime/test/helpers.ts`, passed via `createServer({ queryFn })` or
     `runTurn(input, cfg, queryFn)`. Never call the real model in tests.
   - Follow the closest existing pattern: `routes-sse.test.ts` (SSE streams, abort, 429),
     `routes-rest.test.ts` (REST endpoints), `config.test.ts` (env parsing),
     `runtime.test.ts` (SDK-message → SSE-event mapping), `session-store.test.ts` /
     `session-gc.test.ts` (registry/GC).
   Run `pnpm --filter @app/runtime test` (or `test:watch`) and confirm it fails for the
   *right reason*.
2. **Green — minimum code to pass.** No features beyond what the test requires (CLAUDE.md §2).
3. **Refactor.** Tidy while keeping tests green; keep edits surgical (CLAUDE.md §3).

## Notes

- Pure UI changes in `apps/web` are usually not unit-tested here — verify them in a browser via
  `coding-agent-runtime-verify-web` instead.
- When the change is done, run `coding-agent-runtime-verify-runtime` before handing off.

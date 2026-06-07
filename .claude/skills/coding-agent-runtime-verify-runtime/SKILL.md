---
name: coding-agent-runtime-verify-runtime
description: Use after any change to apps/runtime in coding-agent-runtime. Runs the deterministic gates (pnpm verify) and, when request/SSE/SDK behavior changed, a real end-to-end smoke; fix and re-verify before responding.
---

# Verify a runtime change

Two passes. Fix any failure and re-run before responding to the user.

## Pass 1 — deterministic gates

Run `pnpm verify` (Biome CI + recursive typecheck, test, build). This mirrors the required CI
jobs (`lint`, `verify`) and must be fully green.

> Requires `pnpm` on PATH (same as the `build`/`test` scripts). With a corepack-only setup, run
> the equivalent: `corepack pnpm exec biome ci .` then
> `corepack pnpm -r run typecheck && corepack pnpm -r run test && corepack pnpm -r run build`.

## Pass 2 — real end-to-end turn (when behavior changed)

When the change touches request handling, the SSE stream, session lifecycle, or SDK `Options`,
run one real turn:

1. Start the runtime: `pnpm --filter @app/runtime dev` (loads the repo-root `.env`; listens on
   `127.0.0.1:8080`), or `docker compose up -d --build runtime`.
2. Run `node scripts/smoke.mjs` — it polls `/healthz`, runs one turn over SSE against
   `POST /sessions`, and asserts the stream carried `init` + `result`. Override the target with
   `BASE_URL=...` and the prompt with `--prompt "..."` if needed.
3. Stop the runtime when done.

If the smoke fails, read the runtime logs, fix, and repeat. Only respond once both passes are
green. This skill is the runtime branch of `coding-agent-runtime-delivery-workflow`'s verify phase.

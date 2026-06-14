# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Project Snapshot

> Keep this section current: update it (and the CHANGELOG `[Unreleased]` entry) in the same PR as any change that alters the architecture, deployment model, security posture, or workflow described below.

**What this is:** `coding-agent-runtime` — an HTTP runtime that hosts the Claude Agent SDK as a service. The SDK drives a **decoupled**, separately installed Claude Code CLI (via `pathToClaudeCodeExecutable`, installed with `--no-optional`) over stdio / stream-json, and each turn streams over SSE. The model backend is pluggable via `ANTHROPIC_BASE_URL` (test backend: MiniMax-M3).

**Layout:** pnpm monorepo — `apps/runtime` (Hono + OpenAPIHono server, session registry, OpenTelemetry spans), `apps/web` (Vite + React playground), and `apps/bench` (the benchmark harness; see Benchmarking below). Use `corepack pnpm ...`; pnpm is not on PATH directly.

**Extensibility:** operator-defined custom tools / external MCP servers / hooks / skills plug in through a self-contained `apps/runtime/src/extensions/` subsystem with two authoring tiers — compiled-in code extensions (`BUILTIN_EXTENSIONS`, for in-process tools/hook callbacks) and a declarative JSON manifest (`RUNTIME_EXTENSIONS_FILE`, for external MCP / plugins / skills / dirs). All contributions are folded by `loadExtensions` (once at startup) and merged by one pure composer (`applyExtensions`) that layers a hand-written **safe subset** of `Options` onto the secure base; `runTurn` behaves exactly as before when no extensions are configured. Operator authoring guide: `docs/extensions.md`.

**Benchmarking:** an evaluation/baseline subsystem (in progress) for objectively measuring the runtime's coding ability against industry-standard benchmarks. It lives in `apps/bench` (`@app/bench`) as an **external orchestrator** — it drives the runtime as a black box over the public HTTP/SSE contract and scores out-of-band, so it is deliberately *not* an extension and never touches the runtime core or its security perimeter. The phased plan is SWE-bench-flagship-first: **E0** (done in `[Unreleased]`) is the walking skeleton — the harness pipeline (prepare workspace → drive a turn → pluggable `Scorer` → versioned zod `RunReport`) proven on the in-repo `hello-bench`; later milestones add authoritative SWE-bench scoring (default hosted `sb-cli`, local Docker `swebench` as the offline backend), Aider Polyglot, and a config-tuple baseline + regression-tracking mechanism. Run with `node scripts/bench.mjs`; the harness's vitest suite (fake runtime + recorded SSE fixtures + stub scorer) runs in `pnpm verify` with no model calls.

**Status:** phases P0–P3 complete, plus hosting production guards, a CHANGELOG, and the pluggable extension subsystem. Current release is **v0.8.0** (pluggable extension subsystem — operator-defined custom tools / external MCP / hooks / skills through the two-tier `apps/runtime/src/extensions/` design, with the `docs/extensions.md` authoring guide and a repo-root `REVIEW.md` that calibrates the code-review service) — Git-tagged with a GitHub Release titled `coding-agent-runtime v0.8.0`, every `package.json` at `0.8.0`. The prior release was v0.7.0 (delivery-workflow tooling + SDK/CLI refresh). See `CHANGELOG.md` for the full history.

**Deployment:** single-container, single-tenant / single-task. Docker-ready — `docker compose up -d --build` (runtime + OTel Collector + Jaeger + Prometheus) or a plain `docker run` of the runtime image. Multi-replica / multi-tenant infrastructure (SessionStore, per-tenant isolation) is deliberately deferred and documented in the README "Hosting in production" section; do not add it speculatively.

**Security model:** the agent runs in `bypassPermissions`; the guardrails are a parser-based PreToolUse Bash allowlist (with `disallowedTools` as a backstop) and container hardening (read-only rootfs, `cap_drop: ALL`, no-new-privileges, resource limits, no `curl`/`wget` at runtime). There is **no inbound auth by design** — the runtime binds loopback and expects an auth gateway in front. Extensions are an **operator trust boundary** (supplied by the operator, not remote users); `applyExtensions` structurally prevents a contribution from touching the perimeter (`permissionMode`, `disallowedTools`, `settingSources`, `env`, …) and always keeps the Bash allowlist hook first, but extension custom tools / MCP servers run *outside* that allowlist (it matches only `Bash`), so container hardening is their backstop. See `docs/superpowers/SECURITY-p3.md`.

**Workflow (hard rules):** never push to `main` directly — every change goes through a feature branch → PR → CI → **squash** merge. CI runs six jobs (`lint`, `verify` on Node 22 + 24, `docker`, `audit`, `smoke`); the first five are required branch-protection contexts, `smoke` is not. All repo-published artifacts must be in English (see section 5). The end-to-end delivery loop (plan → TDD → verify → review → PR → CI → squash) is encoded as `coding-agent-runtime-*` skills in `.claude/skills/`; see `CONTRIBUTING.md`. A repo-root `REVIEW.md` tunes the managed Code Review service (and local `/code-review`) with security-first severity calibration centered on the Bash-allowlist parser, container hardening, and the deliberately deferred multi-tenant scope.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. English for Published Artifacts

**Anything published to the public GitHub repository must be written in English.**

- `README.md` and every other Markdown doc tracked in the repo.
- Commit messages.
- The GitHub repo "About"/description.

In-session conversation may continue in the contributor's preferred language; this rule governs only what is published to the repository.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

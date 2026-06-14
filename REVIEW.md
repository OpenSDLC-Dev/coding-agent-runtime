# Review instructions

Review guidance for `coding-agent-runtime` — an HTTP runtime that hosts the Claude Agent
SDK as a service and drives a decoupled, separately installed Claude Code CLI over
stream-json. The agent it hosts runs in `bypassPermissions`, so the runtime's own
guardrails are the security boundary. Calibrate severity and focus accordingly.

## Summary shape

Open the review body with a one-line tally, e.g. `2 important, 3 nits`. Lead with
"No blocking issues" when every finding is a Nit. State the shape before the detail.

## What "Important" means here

Reserve 🔴 Important for findings that would break behavior, weaken the security model,
or break the delivery contract. The highest-value classes for this repo:

- **Sandbox-escape regressions in the Bash allowlist parser**
  (`apps/runtime/src/permissions/bash-allowlist.ts`). This parser is the primary
  guardrail — the hosted agent runs in `bypassPermissions`. A shell-parsing edge case
  that lets a non-allowlisted `argv[0]` (e.g. `curl`, `wget`, `sudo`, `sh`, `bash`,
  `eval`, `xargs`) slip through is Important. Scrutinize quoting, escaping, command
  substitution (`$(...)`, backticks), redirection (`2>&1`, `&>`, `>&`), control
  operators (`;`, `&&`, `||`, `|&`), wrapper stripping (`timeout`, `env`, `nice`, …),
  and `VAR=val` prefixes. Assume the hosted agent is adversarial.
- **Weakening container hardening** (`apps/runtime/Dockerfile`, `docker-compose.yml`,
  `apps/runtime/container/`): re-introducing `curl`/`wget` at runtime, dropping
  `read_only`, `cap_drop: ALL`, `no-new-privileges`, the pids/memory/CPU limits, or
  loosening the egress allowlist.
- **Exposing the unauthenticated runtime**: the runtime binds loopback (`127.0.0.1`)
  by design and expects an auth gateway in front; there is no inbound auth. A change
  that defaults the bind to `0.0.0.0` outside the container, or otherwise removes the
  loopback default, is Important.
- **Leaking internal detail to clients**: `/sessions` returns a generic error plus a
  `correlationId` while logging full detail server-side. A change that streams raw
  error messages, stack traces, env values, or the model backend URL to the client is
  Important.
- **Breaking the SSE turn contract**: clients, `scripts/smoke.mjs`, and the web
  playground depend on a turn streaming `init` … `result` (plus `error`/`aborted`).
  Dropping or mis-ordering these events, or breaking the `traceId` / `X-Trace-Id`
  propagation, is Important.
- **SDK × CLI version drift**: `@anthropic-ai/claude-agent-sdk` and the Dockerfile's
  `CLAUDE_CODE_VERSION` are deliberately pinned in lockstep. Bumping one without the
  other — or adding behavior that depends on an un-pinned CLI feature — is Important.
- **Production-guard regressions**: silently disabling or mis-defaulting
  `RUNTIME_MAX_TURNS`, `RUNTIME_MAX_CONCURRENT_TURNS` (429 admission control),
  `RUNTIME_TURN_TIMEOUT_MS`, or session GC such that a container can OOM or run away.
- Ordinary correctness bugs: logic errors, broken edge cases, and regressions in turn
  handling, session lifecycle/registry, concurrency, and GC.

Style, naming, formatting, and refactoring suggestions are Nit at most.

## Always check

- **A new or changed env var is documented everywhere it lives.** New `RUNTIME_*` /
  config knobs (`apps/runtime/src/agent/config.ts`) must appear in `.env.example`, the
  README configuration table, and — when container-relevant — `docker-compose.yml`.
  Flag a config value read in code but undocumented.
- **Runtime / SSE / SDK-mapping changes have a test.** Tests inject a fake SDK via
  `fakeQueryFn` / `sampleMessages` (`apps/runtime/test/helpers.ts`) — they must not
  call a real model. Flag new SSE event types, routes, or message-mapping branches that
  ship without coverage, and flag any test that reaches a live backend.
- **Docs kept in step in the same PR.** If the diff alters architecture, the deployment
  model, the security posture, or the workflow, the **Project Snapshot** in `CLAUDE.md`
  and the `[Unreleased]` section of `CHANGELOG.md` must be updated in the same PR. Flag
  a missing CHANGELOG/Snapshot update for such a change.
- **English for published artifacts.** Markdown docs, code comments, and commit
  messages that ship to the repo must be English. Flag any non-English published text
  as Important (it violates a hard project rule).
- **Surgical scope.** Every changed line should trace to the stated change. Flag
  drive-by refactors, reformatting of untouched code, and speculative
  abstraction/config that wasn't requested.

## Verification bar

- Claims about the shell-allowlist parser's behavior need a concrete `file:line`
  citation or a specific input string that demonstrates the bypass — not an inference
  from a function name. A parser claim without a worked example is Nit at most.

## Do not report

- Anything CI already enforces: Biome lint/formatting (`biome.json`) and TypeScript
  type errors (the `verify` gate runs typecheck on Node 22 and 24).
- `pnpm-lock.yaml` and any other lockfile.
- The deliberately deferred scope. This is a **single-container, single-tenant,
  single-task** deployment by design. Do **not** suggest multi-replica infrastructure,
  a shared `SessionStore`, per-tenant isolation, horizontal scaling, or built-in
  inbound auth — these are documented non-goals (README "Hosting in production").
- Missing rate limiting / WAF / TLS on the runtime itself — those belong to the
  expected upstream auth gateway, not this process.

## Cap the nits

Report at most five Nits per review. If you found more, add "plus N similar items" to
the summary instead of posting them inline.

## Re-review convergence

After the first review of a PR, post only Important findings and any new Important
issues introduced by later pushes; suppress new Nits. Do not re-raise a finding the
author already addressed.

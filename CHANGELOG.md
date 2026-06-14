# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0/).

> **Note on versions.** Releases 0.1.0–0.5.0 retroactively document the project's
> development milestones (phases P0–P3, then public-release preparation); they were
> not cut as Git tags and predate version numbers in `package.json`. `0.6.0`
> (production hardening) is the first tagged release — annotated tag `v0.6.0`, the point at
> which every `package.json` moved off `0.0.0` to a real, synchronized version. Each date is
> when the milestone merged.

## [Unreleased]

### Added

- Benchmark harness walking skeleton (`apps/bench`, the new `@app/bench` workspace package) — the first piece of an evaluation/baseline subsystem for objectively measuring the runtime's coding ability. The harness is an **external orchestrator**, not an extension: it drives the runtime as a black box over the public HTTP/SSE contract (prepare a clean workspace → `POST /sessions` → reduce the SSE stream to a `TurnOutcome` → score out-of-band), reusing `scripts/smoke.mjs`'s chunk-buffering read loop and "the runtime holds the credentials" property. It ships a pluggable `Scorer` seam (a `stub` for tests, a `localCheckScorer` for in-repo tasks), a versioned, zod-validated `RunReport` schema, a sequential `runBenchmark` runner (one instance at a time, matching the single-workspace runtime), and `hello-bench` — three trivial self-contained instances that prove the pipeline end-to-end with zero external data and zero Docker. Driven via `node scripts/bench.mjs --benchmark hello-bench` against a running runtime; the harness's own vitest suite (fake runtime + recorded SSE fixtures + stub scorer) runs in `pnpm verify` with no model calls. Authoritative SWE-bench / Aider scoring, the config-tuple baseline, and regression tracking are planned follow-up milestones.

## [0.8.0] - 2026-06-14 — Pluggable extension subsystem

### Added

- Pluggable extension subsystem (`apps/runtime/src/extensions/`) for operator-defined **custom tools, external MCP servers, hooks, and skills**, with minimal intrusion into the runtime core. Two authoring tiers: compiled-in code extensions (`BUILTIN_EXTENSIONS`) for in-process tools/hook callbacks, and a declarative JSON manifest (`RUNTIME_EXTENSIONS_FILE`) for external MCP / local plugins / skill enablement / discovery dirs. Contributions are folded once at startup by `loadExtensions` and merged onto the secure base `Options` by one pure composer (`applyExtensions`). Extensions are an operator trust boundary: a hand-written `ExtensionContributions` subset structurally excludes the security perimeter (`permissionMode`, `disallowedTools`, `settingSources`, `env`, …), the Bash allowlist hook is always kept first, and `BASE_DISALLOWED_TOOLS` is always re-asserted; with no extensions configured `runTurn` behaves exactly as before.
- Add `docs/extensions.md`, a complete operator authoring guide for the extension subsystem: how contributions are built once at startup and merged by `applyExtensions`, the `ExtensionContributions` safe-subset field-by-field merge table, worked code-tier examples (a custom tool via `createSdkMcpServer`/`tool()` and a hook callback), the declarative manifest schema reference with a full example, tool-naming/`allowedTools` rules, the `skills` discover-vs-filter gotcha, and verification/troubleshooting. The README "Extensions" section, `.env.example`, and the CLAUDE.md Project Snapshot now link to it.
- Add a repo-root `REVIEW.md` that tunes the managed Code Review service (and the local `/code-review` command) for this repo: security-first severity calibration that treats Bash-allowlist parser regressions, container-hardening rollbacks, exposing the unauthenticated runtime, internal-error leakage, SSE turn-contract breaks, and SDK × CLI version drift as Important; repo-specific "always check" rules (env vars documented across `.env.example`/README/compose, runtime/SSE changes tested via `fakeQueryFn`, same-PR doc sync, English-only artifacts); and skip rules for the deliberately deferred multi-tenant scope and CI-enforced lint/typecheck.

## [0.7.0] - 2026-06-13 — Delivery workflow & SDK/CLI refresh

### Added

- Add a single `pnpm verify` command (Biome CI + recursive typecheck, test, and build) that mirrors the required CI gates, for a one-shot local pre-push check.
- Add `scripts/smoke.mjs`, a portable Node end-to-end smoke that polls `/healthz`, runs one real turn over SSE against `POST /sessions`, and asserts the stream carried `init` + `result`; runnable locally against any running runtime and reused by CI.
- Add the `coding-agent-runtime-*` skill set under `.claude/skills/` that encodes the project's delivery loop as reusable, composable skills: `plan`, `tdd`, `verify-runtime`, `verify-web` (browser-driven), `code-review` (isolated pre-merge agent), and the `delivery-workflow` umbrella that orchestrates them through PR, CI, and squash merge.
- Add a `CONTRIBUTING.md` documenting the plan → TDD → verify → review → PR → squash workflow and a pull request template, and point the README "Development" section at `pnpm verify` and `node scripts/smoke.mjs`.
- Add regression tests pinning that the runtime forwards slash-command prompts (e.g. `/loop`, `/goal`) verbatim to the agent through both `runTurn` and the `POST /sessions` SSE route, locking the prompt-agnostic contract so an SDK/CLI upgrade cannot silently mangle command prompts.
- Document the release naming convention in `CONTRIBUTING.md`: the Git tag is the bare semver `vX.Y.Z`, while the GitHub Release title carries the project name as `coding-agent-runtime vX.Y.Z` (since a Git tag ref cannot contain spaces).

### Changed

- Upgrade the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.161 → 0.3.177) and the decoupled standalone Claude Code CLI (`CLAUDE_CODE_VERSION` 2.1.162 → 2.1.177 in the Dockerfile) to their latest releases, keeping the deliberately version-pinned SDK × CLI pair in lockstep; the `smoke` job's one real turn (against the MiniMax-M3 Anthropic-compatible backend) covers the end-to-end upgrade.
- Refactor the CI `smoke` job to call `scripts/smoke.mjs` instead of inline `curl`/`grep`, so the local and CI real-turn checks share one implementation.

### Fixed

- Report the real runtime version in the container: the entrypoint launches `node` directly (not via npm/pnpm), so `npm_package_version` was unset and `/config`, the OpenAPI `info.version`, and the OTel `service.version` all fell back to `0.0.0`; the entrypoint now exports it from `apps/runtime/package.json`.

### Security

- Resolve the GHSA-gv7w-rqvm-qjhr high-severity advisory in transitive, build-time-only `esbuild` (`<0.28.1`, pulled in via `tsx` and `vite`) by pinning `esbuild` to `^0.28.1` through a root `pnpm.overrides` entry, so the CI `audit` gate (`pnpm audit --audit-level high`) is clean again. esbuild is a build/dev tool and is not present in the production container image.

## [0.6.0] - 2026-06-07 — Hosting production guards

### Added

- Add `RUNTIME_MAX_TURNS` runaway backstop (default 100) capping agentic round-trips per turn, since the Agent SDK has no top-level session timeout.
- Add optional `RUNTIME_TURN_TIMEOUT_MS` per-turn wall-clock deadline that aborts a running turn (emitting an `aborted` event); disabled by default.
- Add `RUNTIME_MAX_CONCURRENT_TURNS` admission control (default 2) that rejects excess concurrent turns with HTTP 429 so subprocesses cannot OOM the host.
- Add opt-in idle-session garbage collection via `RUNTIME_SESSION_TTL_MS` and `RUNTIME_GC_INTERVAL_MS` to reclaim idle sessions and their on-disk transcripts on long-running containers.
- Add a "Hosting in production" README section covering the production guards, gateway auth, single-replica session persistence, multi-tenant scope, and SDK × CLI version pinning, with the new env vars documented in the config table and `.env.example`.
- Add docker-compose production-guard defaults (`RUNTIME_MAX_CONCURRENT_TURNS=2`, `RUNTIME_MAX_TURNS=100`) aligned with the container memory limit.
- Add a CI smoke job that runs one real end-to-end turn to catch SDK × CLI version drift that stubbed unit tests cannot.

## [0.5.0] - 2026-06-06 — Public release preparation + web redesign

### Added

- Add a README with getting-started, configuration, API, and run instructions.
- Add an MIT `LICENSE`.
- Document local (non-container) run variables in `.env.example`, including `RUNTIME_CWD` and `CLAUDE_CONFIG_DIR`, which must point at real, writable local directories for file-writing turns outside Docker.
- Add a GitHub Actions quality gate running on push and PR to `main`: Biome lint, a typecheck/test/build verify matrix on Node 22 and 24, a Docker image build, and a dependency audit that fails on high or critical advisories.

### Changed

- Redesign the web playground as a Twilio Paste Console shell wired to the live runtime: dark topbar with editable runtime URL and live connection dot, model picker, usage meter, and API-docs toggle; a sessions sidebar with status and turn/token/cost meta; streaming chat with collapsible tool cards, per-turn result rows linking to the Jaeger trace, and a changed-files rail; an empty state with prompt suggestions and an auto-growing composer.
- Translate all published artifacts to English: README, SECURITY guide, `.env.example`, source comments, OpenAPI summaries/descriptions, and Playground UI labels.

### Removed

- Remove internal design and planning documents from the public repository.

### Fixed

- Auto-load the repo-root `.env` in the dev/start scripts so a freshly cloned repo no longer crashes with "ANTHROPIC_API_KEY is required" when following the README; stays a no-op in Docker and when env is exported in the shell.

### Security

- Upgrade vitest to 4.1.x (resolves 4.1.8) to clear the critical advisory GHSA-5xrq-8626-4rwp (arbitrary file read/exec via the Vitest UI server).

## [0.4.0] - 2026-06-06 — P3: Security & resilience

### Added

- Add a parser-based Bash command allowlist enforced via a PreToolUse hook: splits compound commands on operators and command substitution, strips wrappers (`timeout`, `nice`, `env`, …) and `VAR=val` prefixes, and denies any sub-command whose `argv[0]` is not allowlisted; the deny applies even under bypass-permissions and to sub-agents.
- Add `RUNTIME_BASH_ALLOWLIST` to override the built-in command allowlist (comma/space-separated; defaults to git, gh, node, npm, python, uv, rg, jq, and other safe tools while excluding `curl`, `wget`, `sudo`, `sh`, `eval`, `xargs`).
- Add a configurable SSE `: keepalive` heartbeat (`RUNTIME_SSE_HEARTBEAT_MS`, default 20000 ms, 0 to disable) to keep streaming connections alive through idle reverse-proxy timeouts.
- Add an opt-in egress allowlist script (`container/egress-allowlist.sh`) that default-drops outbound traffic and permits only DNS plus IPs resolved from `EGRESS_ALLOW_DOMAINS` (GitHub, npm, PyPI, and the Anthropic base URL host by default).
- Document the P3 security model and operations guide (threat model, two-layer Bash enforcement, egress hardening, container hardening, resilience) in `docs/superpowers/SECURITY-p3.md`, with matching `.env.example` entries.

### Changed

- Harden the runtime container in docker-compose: read-only root filesystem with a tmpfs `/tmp`, `cap_drop ALL`, no-new-privileges, and pids/memory/CPU limits.
- Redirect npm, uv, pnpm, gh, git, and XDG cache/config directories to `/tmp` so tooling works under a read-only root filesystem.
- Install jq in the runtime image to match the default Bash allowlist.

### Removed

- Remove the `curl` and `wget` binaries from the runtime image (kept only at build time), leaving no network-fetch executables at runtime.

### Security

- Restrict agent shell execution to an allowlist of commands, blocking arbitrary or unexpected binaries before they run.
- Reduce the container attack surface and egress exposure through read-only rootfs, dropped Linux capabilities, no-new-privileges, resource limits, removal of `curl`/`wget`, and an opt-in network egress allowlist.

## [0.3.0] - 2026-06-05 — P2: OpenTelemetry observability

### Added

- Add OpenTelemetry tracing gated on `OTEL_EXPORTER_OTLP_ENDPOINT`: when set, the runtime starts a NodeSDK OTLP exporter; when unset, spans degrade to no-ops so a bare container produces no connection errors.
- Emit a per-turn `agent.turn` span (carrying `gen_ai.request.model` and `gen_ai.conversation.id`) with nested per-tool child spans, annotated with `gen_ai.*` attributes including token usage (input/output, cache read/creation), cost in USD, and turn count from each result.
- Propagate a unified trace into the child Claude Code CLI by injecting a W3C `TRACEPARENT` env var, linking the CLI's native spans under the runtime turn span (`agent.turn` → tool → `claude_code.*`).
- Surface the trace id to clients via a `traceId` field on `init`/`result` SSE events and an `X-Trace-Id` response header (added to CORS exposeHeaders).
- Add a docker-compose observability backend stack (OTel Collector + Jaeger + Prometheus) with collector and Prometheus configs, wiring runtime and child-CLI telemetry to the collector.
- Add an "Open trace in Jaeger" deep-link in the web chat panel that opens the last turn's trace using the configured `JAEGER_BASE_URL`.

## [0.2.0] - 2026-06-04 — P1: Sessions, REST/OpenAPI, web playground, SDK/CLI decoupling

### Added

- Add SSE conversation endpoints: `POST /sessions` starts a turn and `POST /sessions/{id}/turns` resumes a multi-turn session, streaming `init`/`assistant`/`tool_result`/`result` events (plus `error`/`aborted`).
- Add a session REST API: `GET /sessions` (runtime list with turns, token usage, cost, status, changed files), `GET /sessions/{id}` (info), `GET /sessions/{id}/transcript`, `POST /sessions/{id}/stop` (abort the running turn), and `DELETE /sessions/{id}`.
- Expose an OpenAPI 3.1 spec at `/openapi.json` and interactive Swagger UI at `/docs`, generated from Zod schemas as the single source of truth.
- Report the configured model allowlist on the `/config` endpoint alongside default model and version.
- Add a web playground (`apps/web`, Vite + React + TS) with a connection bar, multi-turn chat panel (live SSE rendering, stop, new conversation), and an embedded API spec view.
- Add a model allowlist (`RUNTIME_ALLOWED_MODELS`): requests for a model outside the list are rejected with HTTP 400.
- Add CORS support configurable via `CORS_ORIGINS` (wildcard or comma-separated origins).
- Add reasoning effort control via `RUNTIME_EFFORT` (low/medium/high/xhigh/max), with invalid values falling back to max.
- Add SDK/CLI decoupling: drive a separately installed Claude Code CLI via `pathToClaudeCodeExecutable` (`RUNTIME_CLAUDE_CLI_PATH`), so the SDK-bundled binary can be excluded with `--no-optional`.

### Changed

- Change the default reasoning effort to max (the SDK default is only high); override with `RUNTIME_EFFORT`.

## [0.1.0] - 2026-06-04 — P0: Containerized runtime skeleton

### Added

- Add an HTTP runtime service (Hono) exposing `GET /healthz`, `GET /config`, and `POST /sessions` for running a single agent turn.
- Stream agent turns over Server-Sent Events on `POST /sessions`, mapping SDK messages to `init`, `assistant`, `tool_result`, `result`, and `error` events.
- Configure the runtime from environment variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `RUNTIME_DEFAULT_MODEL`, `PORT`, `RUNTIME_HOSTNAME`, `RUNTIME_CWD`, `JAEGER_BASE_URL`, `INCLUDE_PARTIAL_MESSAGES`), with a documented `.env.example`.
- Ship a container image (Node 22 bookworm-slim) bundling git, gh, ripgrep, and uv-managed Python 3.12, running as a non-root user with the SDK-bundled CLI.
- Add a container entrypoint that writes fixed agent guidelines to the user-level `CLAUDE.md` and wires gh/git credentials from `GH_TOKEN`, exec-ing the server as PID 1 for correct signal forwarding.
- Shut down gracefully on SIGTERM/SIGINT, closing the HTTP server before exit.

### Security

- Deny dangerous agent Bash commands by default via `disallowedTools` (`curl`, `wget`, `sudo`, `rm -rf`).
- Return a generic error with a correlation ID on `/sessions` while logging full details server-side, so internal error detail is never leaked to clients.
- Default the listen address to loopback (`127.0.0.1`) so the unauthenticated runtime is not silently exposed outside the container.
- Run the agent in bypass-permissions mode, so the `disallowedTools` deny-list is the only built-in guardrail at this stage.

[Unreleased]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/8ab49cb...HEAD
[0.8.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/9de19ce...8ab49cb
[0.7.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/8113e5a...9de19ce
[0.6.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/a9cd553...8113e5a
[0.5.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/6a023be...a9cd553
[0.4.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/9e7da86...6a023be
[0.3.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/f06f3c5...9e7da86
[0.2.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/compare/ba516cb...f06f3c5
[0.1.0]: https://github.com/OpenSDLC-Dev/coding-agent-runtime/commits/ba516cb

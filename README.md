# Coding Agent Runtime

> An HTTP runtime that turns Claude Code into a coding-agent service: the Claude Agent SDK drives a **decoupled** Claude Code CLI, exposing multi-turn coding sessions (SSE streaming), OpenTelemetry observability, and an OpenAPI 3.1 spec.

See [`CHANGELOG.md`](CHANGELOG.md) for the release history.

## What it is

`coding-agent-runtime` composes the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) with a **separately installed** [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) into a stateless HTTP service:

- The SDK drives the standalone Claude Code CLI via `pathToClaudeCodeExecutable` — they talk over stdio / stream-json and can be upgraded independently.
- The container is **stateless**; `CLAUDE_CONFIG_DIR` and the working directory are injected via mounts.
- The model backend is **pluggable** (via `ANTHROPIC_BASE_URL`): this repo uses MiniMax-M3 as the test backend; point it at the official Anthropic API or any Anthropic-compatible gateway instead.

## Features

- **Multi-turn coding sessions**: `POST /sessions` starts a new session and runs the first turn; `POST /sessions/:id/turns` continues via `resume` with preserved context. Everything streams over **SSE** (`init` / `assistant` / `tool_use` / `tool_result` / `result`).
- **Session management**: list / info / transcript / stop (abort the active turn) / delete; runtime state tracks turn count, cumulative tokens, cost, status, and changedFiles.
- **Observability (OpenTelemetry)**: custom `agent.turn` and tool spans + an injected `TRACEPARENT` that stitches the child CLI's native spans into the same trace; usage → span attributes. Ships a compose stack (OTel Collector + Jaeger + Prometheus) and exposes `X-Trace-Id` on responses.
- **OpenAPI 3.1**: `GET /openapi.json` + `GET /docs` (Swagger UI).
- **Security & resilience**: a parser-based PreToolUse Bash allowlist (blocks non-allowlisted commands — even under `bypassPermissions`) plus `disallowedTools` as a backstop; standard container hardening (read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, pids/memory/CPU limits, tmpfs); an SSE `:keepalive` heartbeat to survive idle proxies. See [`docs/superpowers/SECURITY-p3.md`](docs/superpowers/SECURITY-p3.md).
- **Web Playground** (`apps/web`, Vite + React): connect to the runtime, run multi-turn conversations, embed Swagger, and deep-link to Jaeger by traceId.

## Architecture

```
                        HTTP / SSE
   Client / Web  ─────────────────►  Runtime (Hono + OpenAPIHono)
   (apps/web)                          │  session registry · OTel turn/tool spans
                                       │
                                       ▼  Claude Agent SDK
                              pathToClaudeCodeExecutable
                                       │  stdio / stream-json
                                       ▼
                            Claude Code CLI (standalone install)
                                       │  Anthropic-compatible API
                                       ▼
                            Model backend (MiniMax / Anthropic / …)

   OTel spans ──► OTel Collector ──► Jaeger (traces) / Prometheus (metrics)
```

## Repository layout

| Path | Description |
| --- | --- |
| `apps/runtime` | HTTP service (Hono + OpenAPIHono): SDK-drives-CLI, session registry, OTel, security hook |
| `apps/web` | Standalone front-end Playground (Vite + React, browser-only client of the runtime) |
| `otel/` | OTel Collector / Prometheus config |
| `docs/superpowers/` | Security threat model (`SECURITY-p3.md`) |
| `docker-compose.yml` | runtime + otel-collector + jaeger + prometheus, one stack |

## Quick start

### Prerequisites

- **Node ≥ 22**; **pnpm** (via corepack; this repo pins `pnpm@10.34.1`)
- **Docker** (for containers or the observability stack)
- An **Anthropic-compatible model backend + API key**

### Configure

```bash
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY at minimum; adjust ANTHROPIC_BASE_URL / RUNTIME_DEFAULT_MODEL as needed
```

### Run locally (runtime)

```bash
corepack enable
pnpm install
pnpm --filter @app/runtime dev      # tsx watch, listens on 127.0.0.1:8080 by default
curl http://127.0.0.1:8080/healthz  # -> {"status":"ok"}
```

### Web Playground

```bash
pnpm --filter @app/web dev          # Vite dev server; set the connection bar to 127.0.0.1:8080
```

### Docker (with the OTel stack)

```bash
docker compose up -d --build
# runtime   : http://127.0.0.1:8080
# Jaeger    : http://localhost:16686
# Prometheus: http://127.0.0.1:9090
```

### Send a turn (SSE)

```bash
curl -N -X POST http://127.0.0.1:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Create /workspace/hello.txt with the content hello"}'
```

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Health check |
| `GET` | `/config` | Runtime config (default model, allowed models, Jaeger deep-link base, version, …) |
| `POST` | `/sessions` | Create a session and run the first turn (**SSE**) |
| `POST` | `/sessions/:id/turns` | Continue a session (resume, **SSE**) |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id` | Session details (turns / cumulative tokens / cost / status / changedFiles) |
| `GET` | `/sessions/:id/transcript` | Full message transcript |
| `POST` | `/sessions/:id/stop` | Abort the active turn |
| `DELETE` | `/sessions/:id` | Delete a session |
| `GET` | `/openapi.json` | OpenAPI 3.1 spec |
| `GET` | `/docs` | Swagger UI |

Full schema at `/docs`.

## Configuration (`.env`, excerpt)

| Variable | Default | Description |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.minimaxi.com/anthropic` | Model backend (Anthropic-compatible gateway) |
| `ANTHROPIC_API_KEY` | *(required)* | Backend API key |
| `RUNTIME_DEFAULT_MODEL` | `MiniMax-M3` | Default model |
| `RUNTIME_EFFORT` | `max` | Reasoning effort: `low`/`medium`/`high`/`xhigh`/`max` |
| `PORT` | `8080` | Listen port |
| `RUNTIME_HOSTNAME` | `127.0.0.1` | Bind address (set to `0.0.0.0` inside the container by the Dockerfile) |
| `RUNTIME_ALLOWED_MODELS` | *(empty = unrestricted)* | Model allowlist (comma-separated) |
| `CORS_ORIGINS` | `*` | Allowed front-end origins |
| `RUNTIME_BASH_ALLOWLIST` | *(built-in default)* | Bash command allowlist (matches argv[0] basename only) |
| `RUNTIME_SSE_HEARTBEAT_MS` | `20000` | SSE heartbeat interval in ms (`0` = disabled) |
| `RUNTIME_MAX_TURNS` | `100` | Runaway backstop: max agentic turns per turn (`0` = unlimited) |
| `RUNTIME_TURN_TIMEOUT_MS` | `0` | Optional per-turn wall-clock deadline in ms (`0` = disabled) |
| `RUNTIME_MAX_CONCURRENT_TURNS` | `2` | Admission limit; excess turns get HTTP `429` (`0` = unlimited) |
| `RUNTIME_SESSION_TTL_MS` | `0` | Idle-session GC: drop+reclaim a session after this idle time (`0` = disabled) |
| `RUNTIME_GC_INTERVAL_MS` | `3600000` | Idle-session GC sweep interval (only active when TTL > 0) |

Full list and notes in [`.env.example`](.env.example).

## Observability

After `docker compose up`, a single turn produces one unified trace: a custom `agent.turn` root with custom tool spans plus the child CLI's native `claude_code.*` spans, carrying `gen_ai.usage.*` token/cost attributes. In the Playground, click "Open trace in Jaeger" to deep-link by `traceId`. With a bare `docker run` (no `OTEL_EXPORTER_OTLP_ENDPOINT`), telemetry is automatically disabled and spans are no-ops.

## Security notes ⚠️

- **No HTTP authentication**: the design assumes a **trusted network / local host**. Do not expose it directly to the public internet without an auth layer.
- **Two-layer Bash control**: a parser-based PreToolUse allowlist (splits `&& || ; |`, strips `timeout`/`nice`/`env` wrappers, takes the `argv[0]` basename) plus `disallowedTools` as a backstop. Residual risks and the threat model are in [`docs/superpowers/SECURITY-p3.md`](docs/superpowers/SECURITY-p3.md).
- **Container hardening**: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, resource limits, tmpfs, non-root; an optional `container/egress-allowlist.sh` tightens egress.
- **Secrets**: real secrets live only in a local `.env` (gitignored) — never commit them; the in-repo `.env.example` contains only placeholders.

## Hosting in production

This runtime follows the [Agent SDK hosting guide](https://code.claude.com/docs/en/agent-sdk/hosting): the SDK supervises a `claude` CLI subprocess that owns a shell, a working directory, and on-disk session transcripts. The defaults below target a **single-container, single-tenant** deployment (one container per user/task).

**Production guards (enabled by default).** The SDK has *no* top-level session timeout and *no* built-in concurrency cap, so the runtime adds:

- **Runaway backstop** — `RUNTIME_MAX_TURNS` (default 100) bounds agentic round-trips per turn; `RUNTIME_TURN_TIMEOUT_MS` (default off) adds an optional wall-clock deadline that aborts the turn.
- **Admission control** — `RUNTIME_MAX_CONCURRENT_TURNS` (default 2) rejects excess turns with `429` so concurrent subprocesses cannot OOM the host. Size it with `agents = (RAM − overhead) / per-session RAM ceiling` (≈1 GiB/session) and keep it in step with the container `mem_limit`.
- **Disk reclamation** — `RUNTIME_SESSION_TTL_MS` (default off) GCs idle sessions and their transcripts on a long-running container.

**Put auth at a gateway.** Per the hosting guide, the agent should receive *pre-authenticated* requests and must not validate user tokens itself — so the runtime has no inbound auth and binds loopback by default. Front it with an authenticating gateway before exposing it.

**Session persistence is single-replica.** Transcripts live on the mounted `CLAUDE_CONFIG_DIR` volume (the durable source of truth; the in-memory registry is disposable). This is sufficient for one container or a shared network volume. To scale to **multiple replicas**, you must additionally either pin each `sessionId` to one container with consistent-hashing sticky routing, or attach a [`SessionStore`](https://code.claude.com/docs/en/agent-sdk/session-storage) adapter (S3/Redis/Postgres) via `Options.sessionStore` and handle `mirror_error` — neither is wired up today.

**Multi-tenant isolation is out of scope.** Because the deployment model is single-tenant, all sessions share one `cwd` (`/workspace`) and one `CLAUDE_CONFIG_DIR`. Note that **concurrent sessions for the same user share `/workspace`** and can overwrite each other's files. Serving mutually-untrusted tenants from one container would additionally require per-tenant `cwd`/`CLAUDE_CONFIG_DIR`, `settingSources: []`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (see the hosting guide's multi-tenant section).

**SDK × CLI version pinning.** The SDK (`@anthropic-ai/claude-agent-sdk`) and the standalone CLI (`@anthropic-ai/claude-code`, set via `CLAUDE_CODE_VERSION` in the Dockerfile) are deliberately decoupled and talk over stdio/stream-json. They are version-pinned together; CI's `smoke` job runs one real turn end-to-end to catch drift that the stubbed unit tests cannot. Review both changelogs and re-run the smoke turn when bumping either.

## Development

```bash
pnpm verify                            # Biome CI + typecheck + test + build (mirrors required CI)
pnpm -r run test                       # all tests (runtime + web)
pnpm --filter @app/runtime typecheck   # type check
pnpm check                             # Biome format + lint (biome check --write .)
```

For an end-to-end check, run one real turn against a running runtime:

```bash
pnpm --filter @app/runtime dev         # start the runtime on 127.0.0.1:8080
node scripts/smoke.mjs                 # polls /healthz, runs one turn, asserts init + result
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full plan → TDD → verify → review → PR → squash workflow, also encoded as `coding-agent-runtime-*` skills in `.claude/skills/`.

## License

[MIT](LICENSE) © 2026 OpenSDLC-Dev

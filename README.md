# Coding Agent Runtime

> An HTTP runtime that turns Claude Code into a coding-agent service: the Claude Agent SDK drives a **decoupled** Claude Code CLI, exposing multi-turn coding sessions (SSE streaming), OpenTelemetry observability, and an OpenAPI 3.1 spec.

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

Full list and notes in [`.env.example`](.env.example).

## Observability

After `docker compose up`, a single turn produces one unified trace: a custom `agent.turn` root with custom tool spans plus the child CLI's native `claude_code.*` spans, carrying `gen_ai.usage.*` token/cost attributes. In the Playground, click "Open trace in Jaeger" to deep-link by `traceId`. With a bare `docker run` (no `OTEL_EXPORTER_OTLP_ENDPOINT`), telemetry is automatically disabled and spans are no-ops.

## Security notes ⚠️

- **No HTTP authentication**: the design assumes a **trusted network / local host**. Do not expose it directly to the public internet without an auth layer.
- **Two-layer Bash control**: a parser-based PreToolUse allowlist (splits `&& || ; |`, strips `timeout`/`nice`/`env` wrappers, takes the `argv[0]` basename) plus `disallowedTools` as a backstop. Residual risks and the threat model are in [`docs/superpowers/SECURITY-p3.md`](docs/superpowers/SECURITY-p3.md).
- **Container hardening**: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, resource limits, tmpfs, non-root; an optional `container/egress-allowlist.sh` tightens egress.
- **Secrets**: real secrets live only in a local `.env` (gitignored) — never commit them; the in-repo `.env.example` contains only placeholders.

## Development

```bash
pnpm -r run test                       # all tests (runtime + web)
pnpm --filter @app/runtime typecheck   # type check
pnpm check                             # Biome format + lint (biome check --write .)
```

## License

[MIT](LICENSE) © 2026 OpenSDLC-Dev

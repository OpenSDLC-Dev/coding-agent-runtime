# Coding Agent Runtime

> 把 Claude Code 跑成一个可通过 HTTP 调用的「编码 agent 运行时」：Claude Agent SDK 驱动一个**解耦的** Claude Code CLI，对外提供多轮编码对话（SSE 流式）、OpenTelemetry 可观测性与 OpenAPI 3.1 规范。
>
> *An HTTP runtime that turns Claude Code into a coding-agent service — multi-turn streaming sessions, OpenTelemetry tracing, and an OpenAPI 3.1 spec.*

## 这是什么

`coding-agent-runtime` 把 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 与**独立安装**的 [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) 解耦组合，封装成一个无状态的 HTTP 服务：

- SDK 通过 `pathToClaudeCodeExecutable` 驱动独立的 Claude Code CLI——二者经 stdio / stream-json 通信，可各自独立升级。
- 容器**无状态**；`CLAUDE_CONFIG_DIR` 与工作目录通过挂载注入。
- 模型后端**可插拔**（经 `ANTHROPIC_BASE_URL`）：本仓库以 MiniMax-M3 作为测试后端，换成 Anthropic 官方或任何 Anthropic 兼容网关即可。

## 特性

- **多轮编码会话**：`POST /sessions` 起新会话并执行首轮，`POST /sessions/:id/turns` 基于 `resume` 续轮、上下文连续。全程 **SSE 流式**输出（`init` / `assistant` / `tool_use` / `tool_result` / `result`）。
- **会话管理**：list / info / transcript / stop（中止当前活跃轮）/ delete；运行态记录轮次、累计 token、费用、状态、changedFiles。
- **可观测性（OpenTelemetry）**：自建 `agent.turn` 与 tool span + 注入 `TRACEPARENT`，把子 CLI 原生 span 串到同一条 trace；usage → span 属性。自带 compose 栈（OTel Collector + Jaeger + Prometheus），响应头透出 `X-Trace-Id`。
- **OpenAPI 3.1**：`GET /openapi.json` + `GET /docs`（Swagger UI）。
- **安全 + 韧性**：PreToolUse Bash 解析式白名单（拦截非白名单命令，连 `bypassPermissions` 都拦）+ `disallowedTools` 兜底；容器标准硬化（只读 rootfs、`cap_drop: ALL`、`no-new-privileges`、pids/内存/CPU 限额、tmpfs）；SSE `:keepalive` 心跳防 idle 断连。详见 [`docs/superpowers/SECURITY-p3.md`](docs/superpowers/SECURITY-p3.md)。
- **Web Playground**（`apps/web`，Vite + React）：连接 runtime、跑多轮对话、内嵌 Swagger、按 traceId 深链 Jaeger。

## 架构

```
                       HTTP / SSE
   Client / Web  ─────────────────►  Runtime (Hono + OpenAPIHono)
   (apps/web)                          │  会话注册 · OTel turn/tool span
                                       │
                                       ▼  Claude Agent SDK
                              pathToClaudeCodeExecutable
                                       │  stdio / stream-json
                                       ▼
                            Claude Code CLI（独立安装）
                                       │  Anthropic 兼容 API
                                       ▼
                            模型后端（MiniMax / Anthropic / …）

   OTel spans ──► OTel Collector ──► Jaeger（trace）/ Prometheus（metrics）
```

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `apps/runtime` | HTTP 服务（Hono + OpenAPIHono）：SDK 驱动 CLI、会话注册、OTel、安全 hook |
| `apps/web` | 独立前端 Playground（Vite + React，纯浏览器调 runtime） |
| `otel/` | OTel Collector / Prometheus 配置 |
| `docs/superpowers/` | 设计 spec、各期实现 plan、安全威胁模型（SECURITY-p3.md） |
| `docker-compose.yml` | runtime + otel-collector + jaeger + prometheus 一栈起 |

## 快速开始

### 前置

- **Node ≥ 22**；**pnpm**（经 corepack，本仓库 pin `pnpm@10.34.1`）
- **Docker**（跑容器或可观测性栈时）
- 一个 **Anthropic 兼容的模型后端 + API Key**

### 配置

```bash
cp .env.example .env
# 编辑 .env：至少填 ANTHROPIC_API_KEY；按需改 ANTHROPIC_BASE_URL / RUNTIME_DEFAULT_MODEL
```

### 本地直跑（runtime）

```bash
corepack enable
pnpm install
pnpm --filter @app/runtime dev      # tsx watch，默认监听 127.0.0.1:8080
curl http://127.0.0.1:8080/healthz  # -> {"status":"ok"}
```

### Web Playground

```bash
pnpm --filter @app/web dev          # Vite dev server；连接栏填 127.0.0.1:8080
```

### Docker（含 OTel 栈）

```bash
docker compose up -d --build
# runtime  : http://127.0.0.1:8080
# Jaeger   : http://localhost:16686
# Prometheus: http://127.0.0.1:9090
```

### 发一轮对话（SSE）

```bash
curl -N -X POST http://127.0.0.1:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"创建 /workspace/hello.txt，内容为 hello"}'
```

## API

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查 |
| `GET` | `/config` | 运行时配置（默认模型、允许模型、Jaeger 深链基址、版本等） |
| `POST` | `/sessions` | 创建会话并执行首轮（**SSE**） |
| `POST` | `/sessions/:id/turns` | 续轮（resume，**SSE**） |
| `GET` | `/sessions` | 列出会话 |
| `GET` | `/sessions/:id` | 会话详情（轮次 / 累计 token / 费用 / 状态 / changedFiles） |
| `GET` | `/sessions/:id/transcript` | 会话完整消息记录 |
| `POST` | `/sessions/:id/stop` | 中止当前活跃轮 |
| `DELETE` | `/sessions/:id` | 删除会话 |
| `GET` | `/openapi.json` | OpenAPI 3.1 规范 |
| `GET` | `/docs` | Swagger UI |

完整 schema 见 `/docs`。

## 配置项（`.env`，节选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.minimaxi.com/anthropic` | 模型后端（Anthropic 兼容网关） |
| `ANTHROPIC_API_KEY` | *（必填）* | 后端 API Key |
| `RUNTIME_DEFAULT_MODEL` | `MiniMax-M3` | 默认模型 |
| `RUNTIME_EFFORT` | `max` | 推理强度 `low`/`medium`/`high`/`xhigh`/`max` |
| `PORT` | `8080` | 监听端口 |
| `RUNTIME_HOSTNAME` | `127.0.0.1` | 监听地址（容器内由 Dockerfile 设 `0.0.0.0`） |
| `RUNTIME_ALLOWED_MODELS` | *（空 = 不限）* | model 白名单（逗号分隔） |
| `CORS_ORIGINS` | `*` | 允许的前端 origin |
| `RUNTIME_BASH_ALLOWLIST` | *（内置默认）* | Bash 命令白名单（仅匹配 argv[0] basename） |
| `RUNTIME_SSE_HEARTBEAT_MS` | `20000` | SSE 心跳间隔毫秒（`0` = 禁用） |

完整列表与说明见 [`.env.example`](.env.example)。

## 可观测性

`docker compose up` 起栈后，一轮对话会产出一条统一 trace：自建 `agent.turn`（root）下挂自建 tool span + 子 CLI 原生 `claude_code.*` span，带 `gen_ai.usage.*` token/费用属性。Playground 里点「在 Jaeger 打开 trace」即按 `traceId` 深链。裸 `docker run`（不设 `OTEL_EXPORTER_OTLP_ENDPOINT`）时 telemetry 自动关闭、span no-op。

## 安全说明 ⚠️

- **无 HTTP 鉴权**：设计假设运行在**可信网络 / 本机**。请勿不加鉴权层直接暴露到公网。
- **Bash 双层管控**：PreToolUse 解析式白名单（拆 `&& || ; |`、剥 `timeout`/`nice`/`env` 等包装器、取 `argv[0]` basename）+ `disallowedTools` 兜底。残留风险与威胁模型见 [`docs/superpowers/SECURITY-p3.md`](docs/superpowers/SECURITY-p3.md)。
- **容器硬化**：只读 rootfs、`cap_drop: ALL`、`no-new-privileges`、资源限额、tmpfs、非 root 运行；可选 `container/egress-allowlist.sh` 收紧出网。
- **密钥**：真实密钥只放本地 `.env`（已 `.gitignore`），切勿提交；仓库内 `.env.example` 全为占位符。

## 开发

```bash
pnpm -r run test                       # 全部测试（runtime + web）
pnpm --filter @app/runtime typecheck   # 类型检查
pnpm check                             # Biome 格式 + lint（biome check --write .）
```

## 许可

尚未指定 LICENSE。默认保留所有权利；如需开源请补充 `LICENSE` 文件。

# Coding Agent Runtime — 设计文档

- 日期：2026-06-03
- 状态：草案，待用户评审
- 范围（本期）：自包含的 **runtime 容器**（第①层）+ **独立测试界面 Playground**。多容器编排/暖池（第②层）列为后期，仅做接口预留。

---

## 1. 背景与目标

把 Claude Code 跑在云端/本地容器里，对外提供一个 HTTP 服务：调用方可与容器内的 coding agent 进行**单轮 / 多轮对话**完成编码任务；agent 能读写容器内文件系统、执行**白名单内**的 bash 命令；服务暴露 **OpenTelemetry 标准遥测**（LLM 调用链路 + token 消耗）与**标准 OpenAPI 规范**。另配一个**测试界面**用于连接容器、看 spec、对话、看 trace。

### 1.1 目标（In scope）
1. 容器内由 **Claude Agent SDK（TypeScript）调用 SDK 自带的内置 Claude Code 运行时**（无需单独装二进制），对外基于 SDK 提供 HTTP API。
2. HTTP API：创建会话、单/多轮对话（SSE 流式）、查询会话信息、列出会话、停止/中止、删除、拉取 transcript；暴露 **OpenAPI 3.1** + 内置 Swagger UI；开放 **CORS**。
3. **OTel 遥测**：导出 metrics/logs/traces（OTLP），能在 trace 后端看到「每轮→工具→LLM」链路与 token/费用；自带可选后端栈（Collector + Jaeger + Prometheus）。每轮**回传 traceId**。
4. **Bash 命令白名单**：仅允许配置内的命令执行。
5. **容器无状态**：`CLAUDE_CONFIG_DIR`（配置 + 会话记录）与工作目录在容器启动时**动态挂载**；容器可丢弃、可池化。
6. **可配置模型后端**：`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / 模型名可配置，支持 Anthropic 兼容的第三方端点（测试用 MiniMax）。
7. **测试界面（Playground）**：独立 Vite+React 单页，HTTP 连接 runtime；连接配置、查看 OpenAPI、对话（SSE）、按 traceId 深链/内嵌 Jaeger 看 trace。

### 1.2 非目标（Out of scope，本期）
- 多租户鉴权（既定：**无 HTTP 鉴权，可信网络**；CORS 放开）。
- 多容器编排 / 暖池 / 一会话一容器控制面（第②层，后期）。
- 跨主机会话持久化 SessionStore（用挂载目录即可）。
- 计费级成本核算（`total_cost_usd` 仅客户端估算）。
- 测试界面是**开发/验证工具**，非面向终端用户的产品控制台。

### 1.3 已锁定决策
| 维度 | 决策 |
|---|---|
| 语言/驱动 | TypeScript + `@anthropic-ai/claude-agent-sdk`，**用 SDK 自带的内置 CLI**（默认 `pathToClaudeCodeExecutable`，不单独装二进制；靠 pin SDK 版本来 pin CLI） |
| 容器编码工具 | 镜像内置 `git` / `gh` / `node` / `python 3.12`(由 uv 管理) / `uv`，供 agent 经 Bash 编码；`gh/git` 复用本机认证经 `GH_TOKEN`(.env) |
| 容器内 agent 指令 | entrypoint 初始化时把固定 guidelines 写入 `$CLAUDE_CONFIG_DIR/CLAUDE.md`（user-level）；`settingSources:['user','project']`（user=我们的固定 guidelines，project=挂载仓库自带 `./CLAUDE.md`，合并）+ `systemPrompt` 用 `claude_code` preset |
| 会话执行模型 | **无状态每轮 `query({ resume })`**，状态在挂载的 `CLAUDE_CONFIG_DIR` |
| 对外传输 / spec | **SSE + REST**，单份 **OpenAPI 3.1** + Swagger UI；**CORS 开放** |
| HTTP 框架 | **Hono + @hono/zod-openapi** |
| 鉴权 | 无（可信网络） |
| 持久化 | 动态挂载 `CLAUDE_CONFIG_DIR` + 工作目录；容器无状态 |
| Bash 限制 | **PreToolUse hook 强制白名单** + `disallowedTools` 兜底 |
| OTel 后端 | 导出 OTLP + 自带 docker-compose（Collector + Jaeger + Prometheus） |
| 测试界面 | **独立 Vite + React 单页**，HTTP 调 runtime；trace 按 traceId 深链/内嵌 Jaeger |
| 工具链 | **pnpm（workspace）+ vitest + Biome**；Node 22；TS 严格模式 |
| 部署（本期） | runtime 以容器跑在**本地 Docker**（端口映射 + 挂载 + env）；测试前端独立运行 |

---

## 2. 总体架构

```
┌─ 测试界面 Playground（apps/web，独立 Vite+React）──────────┐
│  连接配置(base URL) · OpenAPI 查看(Scalar) · 对话(SSE)     │
│  · 每轮拿 traceId → 「在 Jaeger 打开」深链/iframe          │
└───────────────┬──────────────────────────┬───────────────┘
        HTTP(CORS) │ fetch+ReadableStream(SSE) │ 深链
                   ▼                          ▼
┌─ Coding Agent Runtime 容器（apps/runtime，本地 Docker，端口映射）─┐
│  HTTP API 层  Hono + @hono/zod-openapi                          │
│   REST: POST/GET/DELETE /sessions…  GET /openapi.json /docs /config │
│   SSE : 对话端点返回 text/event-stream（assistant/tool/token/result）│
│  ────────────────────────────────────────────────────────────  │
│  会话编排：每轮 = query({ resume, cwd:/workspace, env, hooks, … }) │
│   Agent SDK ──spawn(自带 cli.js, node, env 已 spread)──► 内置 Claude Code 运行时 │
│  权限层：PreToolUse hook 强制 Bash 白名单 + disallowedTools 兜底   │
│  可观测层：agent.session/turn span + 从消息流补 tool span         │
│           + 注 TRACEPARENT → CLI 原生 claude_code.* span 挂其下    │
└───────────────────────────────────────┬─────────────────────────┘
   运行时挂载/注入（容器无状态）           │ OTLP(4317/4318)
     bind /workspace（固定路径）            ▼
     bind /claude-config（CLAUDE_CONFIG_DIR）  OTel Collector
     env  ANTHROPIC_BASE_URL/KEY · 模型 · OTEL_*   ├─► Jaeger(traces :16686)
                                                   └─► Prometheus(metrics)
```

一轮对话数据流：客户端 `POST /sessions`(或 `/sessions/:id/turns`) 带 prompt → 服务开 `agent.turn` span、注入 `TRACEPARENT` → `query()`（首轮无 resume，后续带）从挂载 `CLAUDE_CONFIG_DIR` 读写 transcript → SDK 消息流映射成 SSE 事件（含 `traceId`、`sessionId`、用量）→ 前端渲染并据 `traceId` 深链 Jaeger。

---

## 3. 配置（环境变量 / `.env`）

配置走环境变量（支持 `.env`，仅本地/可信）。`query()` 经 `options.env: { ...process.env, ... }` 透传给 CLI。
> ⚠️ **TS 坑**：`options.env` 是**整体替换**子进程环境，必须 `...process.env`，否则丢 `PATH`/`HOME`。

### 3.1 模型后端（可配置）
| 变量 | 说明 |
|---|---|
| `ANTHROPIC_BASE_URL` | Anthropic 兼容端点；留空=官方；MiniMax：`https://api.minimaxi.com/anthropic` |
| `ANTHROPIC_API_KEY` | API Key（放 `.env`，不进镜像/日志/trace 属性） |
| `RUNTIME_DEFAULT_MODEL` | 默认主模型（如 `MiniMax-M3`），可被单次请求 `options.model` 覆盖 |
| 辅助"小模型" | 第三方端点下需把后台辅助调用小模型也指向兼容模型（变量名按 CLI 版本确认，见 §13） |

MiniMax 测试 `.env` 样例：
```
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
ANTHROPIC_API_KEY=sk-...        # 勿提交
RUNTIME_DEFAULT_MODEL=MiniMax-M3
```

### 3.2 CLI / 容器
`CLAUDE_CONFIG_DIR`（重定向全部 ~/.claude 状态到挂载盘）、`HOME`（可写）、`DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`（默认禁用保可复现，需跨轮学习则置 0）。
> CLI 运行时由 SDK 自带，不设 `CLAUDE_CLI_PATH`/`pathToClaudeCodeExecutable`；要钉特定 CLI 时再用它作逃生口。

### 3.2.1 编码工具链 / VCS 认证（agent 用）
镜像内置 `git`/`gh`/`node`/`python 3.12`(uv 管理)/`uv`，供 agent 经 Bash 编码。GitHub 认证**复用本机**：本机 `gh auth token` 取 token 写入 `.env` 的 `GH_TOKEN`；容器 entrypoint 跑 `gh auth setup-git`，使 `git push/clone` 也走它。git 提交身份用 `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`。
> ⚠️ `GH_TOKEN` 与 `ANTHROPIC_API_KEY` 同级密钥：仅经 `.env`，不进镜像/日志/trace。`gh/git` 可联网（push/clone/API）= 白名单内的**有意出网口**（见 §6）。

### 3.2.2 容器内 agent 的 CLAUDE.md（运行时固定 guidelines）
镜像内置一份**固定 guidelines 文件**（行为规范，减少常见 LLM 编码错误；内容见仓库 `CLAUDE.md`）。容器 **entrypoint 初始化时**把它写入 `$CLAUDE_CONFIG_DIR/CLAUDE.md`（**user-level** 全局记忆），每次启动幂等覆盖。`query()` 设 `systemPrompt:{type:'preset',preset:'claude_code'}` + `settingSources:['user','project']`，于是容器内 Claude Code 同时加载：
- **user-level = 我们的固定 guidelines**（对所有挂载仓库都生效）；
- **project-level = 挂载仓库 `/workspace` 自带的 `./CLAUDE.md`**（与之合并——正好对应 guidelines 里"Merge with project-specific instructions"）。
> ⚠️ 复用同一 config 目录时该文件会被覆盖（运行时拥有它）。开 `'project'` 会**连带加载挂载仓库的 `.claude/settings.json`（权限/hooks/MCP）= 信任扩到被执行代码**；我们的 Bash 白名单仍以 SDK `hooks`(PreToolUse)+`disallowedTools` 强制，不依赖文件设置（见 §6）。

### 3.3 OTel
`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`（**trace 必需**）+ `OTEL_{TRACES,METRICS,LOGS}_EXPORTER=otlp`（**禁 console**）+ `OTEL_EXPORTER_OTLP_PROTOCOL/ENDPOINT` + `OTEL_*_EXPORT_INTERVAL=1000`（一次性容器防丢）+ `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` + `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1`（指向自定义端点时）。

### 3.4 服务自身
| 变量 | 说明 |
|---|---|
| `PORT` | HTTP 端口（容器内，docker 端口映射到宿主） |
| `RUNTIME_HOSTNAME` | 监听地址。**安全默认 `127.0.0.1`（仅回环）**；容器内由 Dockerfile 显式设 `0.0.0.0`（docker `-p` 端口映射需要）。非隔离部署不会因默认而静默暴露未鉴权端点。 |
| `CORS_ORIGINS` | 允许的前端 origin（可信网络可 `*`） |
| `JAEGER_BASE_URL` | 暴露给前端用于深链（如 `http://localhost:16686`） |
| `INCLUDE_PARTIAL_MESSAGES` | 是否开逐 token（`token` 事件） |

---

## 4. HTTP API 设计

REST（会话增删查）+ SSE（流式），单份 OpenAPI 3.1，Zod 为唯一 schema 源。

### 4.1 端点
```
GET    /healthz                  健康检查
GET    /config                   { defaultModel, jaegerBaseUrl, version, includePartial }（供前端）
GET    /openapi.json             OpenAPI 3.1 文档
GET    /docs                     Swagger UI

POST   /sessions                 创建会话并执行首轮；text/event-stream 返回本轮事件
GET    /sessions                 列出会话（id/状态/模型/轮次/累计 token/最近活跃）
GET    /sessions/:id             会话信息（getSessionInfo + 自跟踪状态/改动文件/费用）
GET    /sessions/:id/transcript  完整 transcript（getSessionMessages；压缩后为压缩链）
POST   /sessions/:id/turns       追加一轮（resume）；text/event-stream 返回本轮事件
POST   /sessions/:id/stop        中止当前轮（abortController.abort()）
DELETE /sessions/:id             删除会话（按策略清理挂载状态/记录）
```
> 对话端点直接以 `text/event-stream` 返回本轮事件流（契合无状态每轮）。**前端用 fetch + ReadableStream 消费**（POST 带 body，`EventSource` 仅支持 GET）。

### 4.2 SSE 事件（名取自 `SDKMessage.type` + 控制事件）
| event | 载荷 |
|---|---|
| `init` | `{ sessionId, traceId, model, cwd, tools }`（来自 system/init；traceId 来自本轮 span） |
| `assistant` | 文本块 + `tool_use` 块 |
| `tool_result` | 工具输出 |
| `token` | 逐 token 增量（仅当 `includePartialMessages`） |
| `result` | `{ sessionId, traceId, usage, total_cost_usd, modelUsage, num_turns, is_error }` |
| `error` / `aborted` | 服务级错误/中止 |
| `:keepalive` | 心跳注释，~20s 防代理断连 |

每事件带 `id:`（`SDKMessage.uuid` 或自增）支持 Last-Event-ID 重放（P3）。响应头也带 `X-Trace-Id`。

### 4.3 OpenAPI 对 SSE 的描述
`responses.200.content['text/event-stream'].schema` 描述**单事件**载荷（3.1 表达不了"连续流"）；事件判别用 `const`；可选生成后补丁成 3.2 `itemSchema`。

---

## 5. 会话执行模型（无状态每轮 resume）
- 首轮：`query({ prompt, options:{ cwd:'/workspace', model, env, hooks, systemPrompt:{type:'preset',preset:'claude_code'}, settingSources:['user','project'] } })`（用 SDK 自带 CLI，不设 `pathToClaudeCodeExecutable`），从 `system/init` 捕获 `session_id` 返回。
- 后续轮：附 `resume: sessionId`，CLI 从挂载 `CLAUDE_CONFIG_DIR/projects/<encoded-/workspace>/<id>.jsonl` 读历史续写。
- **铁律**：`cwd` 容器内**固定 `/workspace`**（transcript 目录由 cwd 编码而来，路径变则 resume 静默失败）。
- 不持有长连接 generator；代价是不能在 agent 跑一半插话（可 `/stop` 中止后再开下一轮）。需中途插话再引入流式输入模式（见 §13）。

---

## 6. 权限与安全
- 容器是真正隔离边界。CLI 以 `permissionMode:'bypassPermissions'`（无人值守）运行，安全靠两层强制：
  1. **PreToolUse hook**（`matcher:'Bash'`）：解析 `tool_input.command`，按 `&& || ; | |& & 换行` 拆分、剥 `timeout/nice/nohup/...` 包装器，任一子命令不在白名单即 `permissionDecision:'deny'`（hook 跑最前、连 bypass 都拦、覆盖子 agent）。
  2. **`disallowedTools` 兜底 deny**：如 `Bash(curl:*)`/`Bash(wget:*)`/`Bash(sudo:*)`/`Bash(rm -rf:*)`（deny 永远赢）。**已提前在 P0 落地**（runtime.ts 的 `query()` 选项里硬编码），不依赖文件设置；第 1 层的完整 PreToolUse 解析式白名单仍在 P3。
- **白名单（含编码工具）**：`git`/`gh`/`node`/`npm`/`npx`/`python`/`python3`/`uv`/`uvx` + 常用只读/文件命令（`ls/cat/rg/…`）。**注意**：`gh/git` 能联网 → 这是**有意开放的出网口**，与 deny `curl/wget` 的收紧方向相反；可信网络可接受，但 P3 的容器 egress 白名单要为 GitHub 域名留行。
- `allowedTools` 仅"自动批准"，不当限制。`settingSources:['user','project']`：**user** 载 entrypoint 写入 `$CLAUDE_CONFIG_DIR/CLAUDE.md` 的固定 guidelines，**project** 载挂载仓库自带 `./CLAUDE.md`（合并，见 §3.2.2）。⚠️ 开 `'project'` 同时载仓库 `.claude/settings.json`（权限/hooks/MCP）= **信任扩到被执行代码**；安全靠我们经 SDK `hooks`(PreToolUse)+`disallowedTools` 强制，不依赖文件设置。
- 文件限定挂载的 `/workspace`；容器层加出网 egress 白名单（P3）。密钥仅经 env/`.env`，不入镜像/日志/trace。

---

## 7. 可观测性 / OTel
### 7.1 自建 span（因 SDK 路径有缺口）
SDK 用 `--input-format stream-json` 驱动 CLI，原生**只产 `claude_code.llm_request` span**，丢 `interaction`(每轮) 与 `tool` 层（issue #53954，已"不修"）。因此：
- Node 服务自建 `agent.session`（按 sessionId）→ `agent.turn`（每轮，`SpanKind.SERVER`）。
- 把 turn span 上下文序列化为 `TRACEPARENT` 注入 `options.env`，CLI 原生 span 挂其下，形成统一 trace；本轮 `traceId` 经 SSE/响应头回传前端。
- **工具树**：从消息流按 `tool_use`/`tool_result`（`tool_use_id`）补 tool span。
- **token/费用**：从 `SDKResultMessage` 读 `usage`/`total_cost_usd`/`modelUsage` 打到 turn span（`gen_ai.usage.*`）；按 `message.id` 去重并行工具消息。
- 跨轮归并：用 `gen_ai.conversation.id = sessionId` 属性在后端归并。

### 7.2 后端栈（自带，可换）
`docker-compose`：OTel Collector（OTLP 4317/4318）→ Jaeger（:16686，前端深链目标）+ Prometheus。Collector 可加 transform 把 `claude_code.*` 映射成 `gen_ai.*`。

### 7.3 注意点
trace 是 beta（需 `ENHANCED_TELEMETRY_BETA=1`）；禁 console exporter；一次性容器降导出间隔/调大 `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS`；内容默认脱敏；**MiniMax 等第三方端点**成本估算失真、仅 token 可信、看上游需 `PROPAGATE_TRACEPARENT=1`；GenAI 语义约定仍实验（`gen_ai.system`→`gen_ai.provider.name` 可能变）。

---

## 8. 容器与挂载
### 8.1 镜像要点
`node:22-bookworm-slim`（**非 alpine**）；装 `git gh ca-certificates ripgrep curl libstdc++6`（`gh` 加 GitHub apt 源）；装 **uv** 并 `uv python install 3.12 --default`（提供 `python3.12`/`python3` shim）；**CLI 运行时随 SDK 自带**——`pnpm install`（含 `@anthropic-ai/claude-agent-sdk`，**不裁 optional 依赖**）即带 CLI，靠 pin SDK 版本来 pin CLI，**不单独装二进制**；非 root 用户（固定 UID/GID），预建并 chown `/workspace`、`/claude-config`；内置固定 agent guidelines 文件（→ entrypoint 写 `$CLAUDE_CONFIG_DIR/CLAUDE.md`，见 §3.2.2）；`DISABLE_AUTOUPDATER=1`；`EXPOSE $PORT`。

### 8.2 运行时（本地 Docker）
`docker run` 时：`-p 127.0.0.1:宿主:容器`（**绑宿主回环**，未鉴权端点不暴露到局域网）、`-v 工作目录:/workspace`、`-v 配置目录:/claude-config`、`--env-file .env`（含 `ANTHROPIC_*`、`GH_TOKEN`、`GIT_AUTHOR_*`）、设 `CLAUDE_CONFIG_DIR=/claude-config`。挂载目录 chown 到容器 UID:GID（bind mount 第一坑）。entrypoint 初始化：写 `$CLAUDE_CONFIG_DIR/CLAUDE.md`（固定 guidelines）+ 跑 `gh auth setup-git`。**用 SDK 自带 CLI**，不设 `pathToClaudeCodeExecutable`。可提供 `docker-compose.yml` 一并起 runtime + OTel 栈。

---

## 9. 测试界面（Playground）
- 形态：独立 **Vite + React + TS** 单页（`apps/web`）；开发 `pnpm --filter web dev`，可 `build` 成静态产物。
- 连接：顶部输入 runtime base URL（默认 `http://localhost:<PORT>`）；拉 `GET /healthz` + `GET /config` 确认连通并取 `jaegerBaseUrl`/`defaultModel`。runtime 开放 **CORS**。
- 功能区：
  1. **连接/配置**：base URL、模型名（默认取 `/config`）、会话选择/新建。
  2. **OpenAPI 查看**：内嵌 **Scalar**（`@scalar/api-reference`）加载 runtime 的 `/openapi.json`（亦可直接开 runtime 的 `/docs`）。
  3. **对话**：`POST /sessions`(首轮) / `POST /sessions/:id/turns`(后续)，用 **fetch + ReadableStream** 解析 `text/event-stream`，实时渲染 assistant 文本、工具调用/结果、token、最终用量/费用；多轮 resume；「停止」调 `/stop`。
  4. **trace**：每轮从 `result` 事件取 `traceId`，提供「在 Jaeger 打开」深链 `<jaegerBaseUrl>/trace/<traceId>`，或 iframe 内嵌。
- 技术取舍：状态用 React 内置（必要时 zustand）；样式保持简单（Tailwind 或原生 CSS）；不引入重型 UI 库（CLAUDE.md 简单优先）。

---

## 10. 工程结构与工具链
**pnpm workspace** 单仓双包：
```
opensdlc/coding-agent-runtime/
  pnpm-workspace.yaml         # apps/*
  package.json                # 根脚本（dev/build/test/lint）
  biome.json                  # 统一 lint+format（对齐兄弟项目 ruff 理念）
  tsconfig.base.json
  docker-compose.yml          # runtime + OTel 栈（Collector/Jaeger/Prometheus）
  apps/
    runtime/
      Dockerfile
      container/
        entrypoint.sh         初始化：写 $CLAUDE_CONFIG_DIR/CLAUDE.md + gh auth setup-git + 起服务
        agent-CLAUDE.md       容器内 agent 的固定 guidelines（内容同根 CLAUDE.md）
      src/
        server.ts             Hono 装配（路由、OpenAPI、Swagger UI、CORS、healthz、config）
        telemetry.ts          OTel NodeSDK 引导（--import 先加载）；tracer 单例
        routes/sessions.ts    REST + SSE 路由（zod schema + createRoute）
        agent/runtime.ts      runTurn(prompt, resumeId?) → query() 封装 + 事件映射 + span
        agent/session-store.ts 会话注册表（状态/费用/改动文件/最近活跃）
        agent/config.ts       env → 配置（校验 BASE_URL/KEY/model）
        permissions/bash-allowlist.ts  PreToolUse hook + disallowedTools
        otel/spans.ts         session/turn span + TRACEPARENT 注入 + tool 树
        otel/usage.ts         SDKResultMessage → span 属性（去重）
        schemas/              Zod schema（Session/Turn/Event/Error…）
      test/                   vitest 单测（runtime.runTurn 与 HTTP 解耦便于测）
    web/
      src/                    Vite + React（连接/spec/对话/trace 四区）
      index.html  vite.config.ts
```
工具链：**pnpm**（锁文件 `pnpm-lock.yaml` 提交）、**vitest**（测试）、**Biome**（lint+format）、TS 严格模式、Node 22（`engines` + `.nvmrc`）。每单元职责单一、可独立测试。

---

## 11. 关键风险与坑（清单）
1. `options.env` 整体替换 → 必须 `...process.env`。
2. `cwd` 路径必须恒定（`/workspace`），否则 resume/transcript 丢失。
3. **CLI 运行时用 SDK 自带的内置 cli.js**（默认 `pathToClaudeCodeExecutable`），无需装原生二进制；版本随 SDK → **靠 pin SDK 版本来 pin CLI**（旧的绝对路径/`executable:'node'`/ENOENT 坑随之消除）。
4. trace 需 `ENHANCED_TELEMETRY_BETA=1`；SDK 路径缺 interaction/tool span → 自建。
5. 禁 console exporter；一次性容器降导出间隔防丢。
6. 镜像勿裁 optional 依赖；用 slim Debian 非 alpine。
7. bind mount 的 UID/GID 必须对齐容器用户。
8. 第三方端点（MiniMax）：成本估算失真；主/辅模型都要指兼容模型；需 `PROPAGATE_TRACEPARENT`。
9. auto-memory 默认开会写挂载盘 → 按需禁用。
10. transcript 默认 30 天清理（`cleanupPeriodDays`）。
11. Bash 白名单要自拆 `&& || ; |`、剥包装器；`npx/docker exec` 类不被自动剥离。
12. **CORS**：前端独立 origin，runtime 必须开 CORS（含 SSE 响应）。
13. **SSE 经 POST**：前端不能用 `EventSource`，须 fetch+ReadableStream。
14. **traceId 深链**：依赖 runtime 正确把 turn span 的 traceId 透出（SSE `result` + `X-Trace-Id` 头）。
15. **gh/git 是联网工具**：白名单放它们 = 有意出网口（push/clone/GitHub API），与 deny `curl/wget` 相反；P3 egress 白名单要给 GitHub 域名留行。
16. **`GH_TOKEN` 是密钥**：与 `ANTHROPIC_API_KEY` 同级，仅 `.env`，不进镜像/日志/trace。
17. **Debian 无 python 3.12**：用 `uv python install 3.12 --default` 提供，agent 走 `uv run/venv/pip`（别假设系统 `python3` 就是 3.12）。
18. **`settingSources` 默认空 = 不读任何 CLAUDE.md**：必须显式 `['user','project']`；user-level 写到 `$CLAUDE_CONFIG_DIR/CLAUDE.md`。
19. **开 `'project'` 会连带载仓库 `.claude/settings.json`**（权限/hooks/MCP）= 信任扩到被执行代码；安全仍靠 SDK `hooks`+`disallowedTools` 强制（不信文件设置）。

---

## 12. 分阶段实施计划
| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 骨架** | pnpm workspace + Biome/vitest/tsconfig；apps/runtime：Hono + healthz/config + Dockerfile（SDK 自带 CLI + git/gh/uv/py3.12）+ entrypoint（写 `$CLAUDE_CONFIG_DIR/CLAUDE.md`）+ `runTurn` 单轮（`systemPrompt` preset + `settingSources:['user','project']`）+ SSE 出流 | 本地 `docker run` 后 `POST /sessions` 能流式返回 agent 输出；容器内 agent 遵循固定 guidelines |
| **P1 多轮+会话+界面骨架** ✅已实现 | 每轮 resume、Session Registry、`/sessions/*` 全套、OpenAPI+Swagger UI+CORS；`ANTHROPIC_BASE_URL/KEY/model` 可配（MiniMax 跑通）；apps/web：连接+spec 查看+SSE 对话 | 多轮上下文连续；MiniMax-M3 完成真实任务；界面能连容器、看 spec、对话 |
| **P2 可观测性+界面 trace** | telemetry.ts、session/turn span、TRACEPARENT 注入、tool 树、usage→span、compose 后端栈；SSE/响应头透出 traceId；界面深链/内嵌 Jaeger | Jaeger 看到「turn→tool→llm_request」链路与 token；界面按 traceId 一键看 trace |
| **P3 安全+韧性** | PreToolUse Bash 白名单 + disallowedTools + egress 白名单 + 容器硬化；Last-Event-ID 重放/心跳；abort 接线 | 越权 bash 被拦并回有意义信息；断线可重连；中止生效 |
| **P4（可选）规模化** | 第②层编排：控制面 spawn 一会话一容器、动态挂载、生命周期/暖池/路由 | 多会话并发各自隔离；暖池冷启动秒级 |

每阶段以"可运行 + 可验证"为准（CLAUDE.md §4）。

---

## 13. 开放问题 / 待验证
1. **MiniMax 兼容性**：`/anthropic` 端点对 streaming、`usage` 字段、prompt caching、enhanced-telemetry beta 的支持；辅助"小模型"的确切环境变量名（随 CLI 版本变）。
2. issue #53954（streaming 模式缺 interaction/tool span）是否在更新 CLI 版本悄悄修复 → 对 pin 版本实测。
3. 用单 string prompt（非 async-iterable）驱动是否恢复完整 span 树 → 实测。
4. `TRACEPARENT` 是否需同带 `TRACESTATE` 与 sampled 标志才被 CLI 采纳 → 隔离环境验证（不能在 SDK 主通道用 console）。
5. 删除会话时挂载状态清理策略（保留/归档/删除）与 30 天自动清理的取舍。
6. Scalar vs 直接复用 runtime `/docs` 的取舍（界面内嵌是否值得，或直接给链接）。（**P1 决策**：界面用 iframe 内嵌 runtime 的 `/docs` + 直链，不引入 Scalar；后续如需再评估。）
7. **自带 CLI 在容器 headless 下被 `query()` 驱动**是否稳定（含 stream-json 路径、resume）→ P0 实测；必要时回退到显式装 CLI + `pathToClaudeCodeExecutable`。

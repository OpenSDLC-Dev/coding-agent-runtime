# Coding Agent Runtime P2（OTel 可观测性 + 界面 trace）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 runtime 对外提供 OpenTelemetry 标准 trace —— 在 Jaeger 能看到「agent.turn → tool → claude_code.llm_request」统一链路与 token/费用，并让 Playground 按 traceId 一键深链 Jaeger。

**Architecture:** Node 服务为每一轮对话自建 `agent.turn` span（`SpanKind.SERVER`），把其 W3C `traceparent` 注入子 CLI 的 `options.env`，配合 `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1` 让 CLI 原生 span 挂到 turn span 之下形成一条 trace；从 SDK 消息流（`tool_use`/`tool_result`）补 tool 子 span，从 `result` 消息把 `usage`/`cost` 打成 `gen_ai.usage.*` 属性。本轮 `traceId` 经 SSE 的 `init`/`result` 事件载荷 + 响应头 `X-Trace-Id` 回传前端。自带 `docker-compose`（OTel Collector + Jaeger + Prometheus）做后端栈。

**实现决策（实现细节，非 spec 设计变更；spec §7/§3.3 为依据）：**
1. **telemetry 初始化用 `index.ts` 顶部副作用 import**，不用 spec 文字提到的 `--import`：P2 只做手动 span（不打 HTTP auto-instrumentation），副作用 import 即可在 app 之前注册全局 TracerProvider，省掉 entrypoint/tsx 的 `--import` 复杂度。
2. **遥测门控 = `OTEL_EXPORTER_OTLP_ENDPOINT` 是否存在**：compose 起栈时设它 → 启真实 OTLP 导出；裸 `docker run`（无 collector）不设 → `getTracer()` 返回 no-op，span 不产生、不报连接错误。
3. **子 CLI 的 `OTEL_*` / `CLAUDE_CODE_*` env 由现有 `buildChildEnv`（已 `spread process.env`）自动继承**；runtime 每轮只额外注入动态 `TRACEPARENT`（且仅当 turn span 的 spanContext 有效时）。
4. **span 副作用复用 `mapMessage` 产出的 SSE 事件**（`assistant.toolUses` 带 `id`、`tool_result.results` 带 `toolUseId`/`isError`），不重新遍历原始 `SDKMessage`，保持 DRY。
5. **OTel 包钉版本**：`@opentelemetry/api@1.9.1`、`@opentelemetry/sdk-node@0.218.0`、`@opentelemetry/exporter-trace-otlp-proto@0.218.0`、`@opentelemetry/resources@2.7.1`、`@opentelemetry/semantic-conventions@1.41.1`。

**Tech Stack:** TypeScript（runtime: NodeNext，import 带 `.js`）、@opentelemetry/* JS SDK（手动 span）、Hono SSE、Docker Compose（otel-collector-contrib / jaeger all-in-one / prometheus）、Vite+React（web：Bundler 解析，import 不带扩展名）、vitest、Biome。

**前置事实（实现者须知）：**
- 工作目录 `C:\Users\HE LE\Project\opensdlc\coding-agent-runtime`，pnpm workspace 双包 `apps/runtime`（`@app/runtime`）+ `apps/web`（`@app/web`）。
- pnpm 只能这样调：`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 <args>`。安装依赖用 `--filter @app/runtime`；本机有 HTTP 代理（`HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:1235`）。
- runtime 测试入口 `apps/runtime/test/*.test.ts`，跑：`corepack pnpm@10.34.1 --filter @app/runtime test`；typecheck：`... --filter @app/runtime typecheck`。
- biome 检查改动文件：`corepack pnpm@10.34.1 exec biome check <files>`（提交前必须 exit 0）。
- 现有 `runtime.ts` 的 `runTurn(input, cfg, queryFn)` 是 async generator，逐条把 `SDKMessage` 经 `mapMessage` 映射为 `SseEvent` 后 `yield`。`mapMessage` 已提取：`init` 事件 `{sessionId,model,cwd,tools}`、`assistant` 事件 `{text,toolUses:[{id,name,input}]}`、`tool_result` 事件 `{results:[{toolUseId,isError}]}`、`result` 事件 `{sessionId,usage,total_cost_usd,modelUsage,num_turns,is_error}`。
- `buildChildEnv(cfg)` 已 `spread process.env` 并叠加 `ANTHROPIC_*`/`CLAUDE_CONFIG_DIR`/`DISABLE_AUTOUPDATER`。
- 现有测试 helper：`apps/runtime/test/helpers.ts` 导出 `testConfig`、`fakeQueryFn(messages)`、`sampleMessages`（init→assistant(text+tool_use Bash)→user(tool_result)→result success）、`collectSse(res)`。
- git 工作流：在 `main` 上先建特性分支 `feat/p2-otel-observability`，逐 Task commit，最后 `--no-ff` 合回 main（与 P0/P1 一致）。

---

## File Structure（先锁定分解）

**新建（runtime）**
- `apps/runtime/src/telemetry.ts` — OTel NodeSDK 引导：`startTelemetry()`（门控 + 启 OTLP 导出）、`getTracer()`（tracer 单例）、`shutdownTelemetry()`。
- `apps/runtime/src/otel/spans.ts` — `startTurnSpan()`、`traceparentOf()`、`startToolSpan()`。
- `apps/runtime/src/otel/usage.ts` — `setUsageAttributes()`（SDKResultMessage → `gen_ai.usage.*`）。
- `apps/runtime/test/telemetry.test.ts`、`apps/runtime/test/otel-spans.test.ts`、`apps/runtime/test/otel-usage.test.ts`。

**修改（runtime）**
- `apps/runtime/src/agent/runtime.ts` — runTurn 包 turn span、注 TRACEPARENT、补 tool span、打 usage、`init`/`result` 事件加 `traceId`。
- `apps/runtime/src/index.ts` — 启动前 `startTelemetry()`；SIGTERM/SIGINT 时 `shutdownTelemetry()` flush。
- `apps/runtime/src/server.ts` — CORS `exposeHeaders:['X-Trace-Id']`。
- `apps/runtime/src/routes/sessions.ts` — 预读 init 后把 `traceId` 写 `X-Trace-Id` 响应头。
- `apps/runtime/test/runtime.test.ts`、`apps/runtime/test/routes-sse.test.ts` — 补 span/traceId 断言。
- `apps/runtime/package.json` — 加 OTel deps。

**新建（仓库根 / 部署）**
- `docker-compose.yml` — runtime + otel-collector + jaeger + prometheus。
- `otel/collector-config.yaml`、`otel/prometheus.yml`。
- `.env.example` — 补 OTEL 注释。

**新建/修改（web）**
- `apps/web/src/lib/trace.ts`（新）— `traceUrl()` 纯函数。
- `apps/web/src/lib/trace.test.ts`（新）。
- `apps/web/src/components/ChatPanel.tsx`、`apps/web/src/App.tsx` — 传 `jaegerBaseUrl`、渲染「在 Jaeger 打开」深链。

---

## Task 0: 建特性分支

- [ ] **Step 1: 从最新 main 建分支**

```bash
git checkout main
git checkout -b feat/p2-otel-observability
git log --oneline -1   # 预期 HEAD = f06f3c5（P2 起点：effort 合并后的 main）
```

---

## Task 1: OTel 依赖 + telemetry 引导 + index 接线

**Files:**
- Modify: `apps/runtime/package.json`（dependencies 加 5 个 `@opentelemetry/*`）
- Create: `apps/runtime/src/telemetry.ts`
- Modify: `apps/runtime/src/index.ts`
- Test: `apps/runtime/test/telemetry.test.ts`

- [ ] **Step 1: 安装 OTel 依赖**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime add \
  @opentelemetry/api@1.9.1 \
  @opentelemetry/sdk-node@0.218.0 \
  @opentelemetry/exporter-trace-otlp-proto@0.218.0 \
  @opentelemetry/resources@2.7.1 \
  @opentelemetry/semantic-conventions@1.41.1
# sdk-trace-base 仅测试用（InMemorySpanExporter/BasicTracerProvider/SimpleSpanProcessor）。
# 它是 sdk-node 的传递依赖，但 pnpm 严格隔离下直接 import 传递依赖会失败 → 必须显式加为 devDependency。
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime add -D \
  @opentelemetry/sdk-trace-base@2.7.1
```

预期：`apps/runtime/package.json` 的 `dependencies` 新增 5 项 + `devDependencies` 新增 `@opentelemetry/sdk-trace-base`；`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 写 telemetry 单测（先失败）**

`apps/runtime/test/telemetry.test.ts`：

```ts
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { getTracer, shutdownTelemetry, startTelemetry } from "../src/telemetry.js";

describe("telemetry", () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it("does not start the SDK when no OTLP endpoint is configured", () => {
    expect(startTelemetry({}, "0.0.0")).toBe(false);
  });

  it("starts the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    const started = startTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      "1.2.3",
    );
    expect(started).toBe(true);
  });

  it("is idempotent (second start is a no-op returning true)", () => {
    startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    expect(startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toBe(true);
  });

  it("getTracer always returns a usable tracer (no-op when not started)", () => {
    const tracer = getTracer();
    const span = tracer.startSpan("probe");
    span.end();
    expect(typeof trace.getTracer).toBe("function");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test telemetry
```
预期：FAIL（`../src/telemetry.js` 不存在）。

- [ ] **Step 4: 实现 telemetry.ts**

`apps/runtime/src/telemetry.ts`：

```ts
import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "coding-agent-runtime";

let sdk: NodeSDK | undefined;

// 仅当配置了 OTLP 端点（compose 起栈）才启动真实导出；否则 span 退化为 no-op，
// 裸 docker run 不产生连接错误。返回是否启动了真实 SDK；幂等。
export function startTelemetry(env: NodeJS.ProcessEnv = process.env, version = "0.0.0"): boolean {
  if (sdk) return true;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || TRACER_NAME,
      [ATTR_SERVICE_VERSION]: version,
    }),
    // OTLPTraceExporter 从 OTEL_EXPORTER_OTLP_ENDPOINT 读端点（自动追加 /v1/traces）。
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  return true;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test telemetry
```
预期：PASS（4 tests）。

- [ ] **Step 6: 接线 index.ts（启动前初始化、退出时 flush）**

把 `apps/runtime/src/index.ts` 改为：

```ts
import { serve } from "@hono/node-server";
import { loadConfig } from "./agent/config.js";
import { createServer } from "./server.js";
import { shutdownTelemetry, startTelemetry } from "./telemetry.js";

const config = loadConfig();
const version = process.env.npm_package_version;
const telemetryOn = startTelemetry(process.env, version);

const app = createServer({ config, version });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, (info) => {
  console.log(
    `runtime listening on http://${config.hostname}:${info.port} (telemetry ${telemetryOn ? "on" : "off"})`,
  );
});

const shutdown = (): void => {
  server.close(() => {
    void shutdownTelemetry().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 7: typecheck + biome**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 exec biome check apps/runtime/src/telemetry.ts apps/runtime/src/index.ts apps/runtime/test/telemetry.test.ts
```
预期：typecheck 0 错误；biome exit 0（如有 import 排序问题，先 `biome check --write` 再 commit）。

- [ ] **Step 8: commit**

```bash
git add apps/runtime/package.json pnpm-lock.yaml apps/runtime/src/telemetry.ts apps/runtime/src/index.ts apps/runtime/test/telemetry.test.ts
git commit -m "feat(otel): telemetry 引导（NodeSDK 门控 OTLP 导出）+ index 接线"
```

---

## Task 2: span 助手（otel/spans.ts）

**Files:**
- Create: `apps/runtime/src/otel/spans.ts`
- Test: `apps/runtime/test/otel-spans.test.ts`

- [ ] **Step 1: 写 span 助手单测（先失败）**

`apps/runtime/test/otel-spans.test.ts`：用内存 exporter 验证 span 关系与 traceparent 格式。

```ts
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startToolSpan, startTurnSpan, traceparentOf } from "../src/otel/spans.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

describe("otel/spans", () => {
  it("startTurnSpan creates a SERVER span carrying model + conversation id", () => {
    const span = startTurnSpan({ model: "MiniMax-M3", resumeId: "sess-1" });
    span.end();
    const [s] = exporter.getFinishedSpans();
    expect(s?.name).toBe("agent.turn");
    expect(s?.attributes["gen_ai.request.model"]).toBe("MiniMax-M3");
    expect(s?.attributes["gen_ai.conversation.id"]).toBe("sess-1");
  });

  it("traceparentOf serializes a valid W3C traceparent", () => {
    const span = startTurnSpan({});
    const tp = traceparentOf(span);
    span.end();
    const sc = span.spanContext();
    expect(tp).toBe(`00-${sc.traceId}-${sc.spanId}-01`);
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("startToolSpan nests the tool span under the turn span", () => {
    const turn = startTurnSpan({});
    const tool = startToolSpan(turn, { name: "Bash", id: "tu-1" });
    tool.end();
    turn.end();
    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.name === "tool:Bash");
    expect(toolSpan?.attributes["gen_ai.tool.name"]).toBe("Bash");
    expect(toolSpan?.attributes["gen_ai.tool.call.id"]).toBe("tu-1");
    // 父子关系：tool span 的 parent = turn span 的 spanId
    expect(toolSpan?.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test otel-spans
```
预期：FAIL（`../src/otel/spans.js` 不存在）。

- [ ] **Step 3: 实现 otel/spans.ts**

`apps/runtime/src/otel/spans.ts`：

```ts
import { context as otelContext, type Span, SpanKind, trace } from "@opentelemetry/api";
import { getTracer } from "../telemetry.js";

// 开 turn span（SpanKind.SERVER）。首轮 sessionId 未知，仅 resume 轮先带 conversation.id；
// 首轮在 init 事件到达后由 runTurn 补设。
export function startTurnSpan(attrs: { model?: string; resumeId?: string }): Span {
  return getTracer().startSpan("agent.turn", {
    kind: SpanKind.SERVER,
    attributes: {
      "gen_ai.operation.name": "chat",
      ...(attrs.model ? { "gen_ai.request.model": attrs.model } : {}),
      ...(attrs.resumeId ? { "gen_ai.conversation.id": attrs.resumeId } : {}),
    },
  });
}

// W3C traceparent：00-<trace-id>-<span-id>-<flags>。注入子 CLI 的 env，配合
// CLAUDE_CODE_PROPAGATE_TRACEPARENT=1 让 CLI 原生 span 挂到 turn span 之下。
export function traceparentOf(span: Span): string {
  const sc = span.spanContext();
  const flags = (sc.traceFlags & 0x1).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

// 在 turn span 之下开 tool 子 span（显式以 turn span 构造父 context，不依赖 active context）。
export function startToolSpan(parent: Span, tool: { name: string; id: string }): Span {
  const ctx = trace.setSpan(otelContext.active(), parent);
  return getTracer().startSpan(
    `tool:${tool.name}`,
    { attributes: { "gen_ai.tool.name": tool.name, "gen_ai.tool.call.id": tool.id } },
    ctx,
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test otel-spans
```
预期：PASS（3 tests）。若 `parentSpanContext` 在该版本为 `undefined`，改断言为 `toolSpan?.parentSpanContext?.spanId ?? (toolSpan as { parentSpanId?: string }).parentSpanId` —— 但 sdk-trace-base 2.7 用 `parentSpanContext`，正常应直接通过。

- [ ] **Step 5: typecheck + biome + commit**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 exec biome check apps/runtime/src/otel/spans.ts apps/runtime/test/otel-spans.test.ts
git add apps/runtime/src/otel/spans.ts apps/runtime/test/otel-spans.test.ts
git commit -m "feat(otel): turn/tool span 助手 + traceparent 序列化"
```

---

## Task 3: usage → span 属性（otel/usage.ts）

**Files:**
- Create: `apps/runtime/src/otel/usage.ts`
- Test: `apps/runtime/test/otel-usage.test.ts`

- [ ] **Step 1: 写单测（先失败）**

`apps/runtime/test/otel-usage.test.ts`：用一个收集 setAttribute 的假 span。

```ts
import type { Span } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { setUsageAttributes } from "../src/otel/usage.js";

function fakeSpan() {
  const attrs: Record<string, unknown> = {};
  const span = {
    setAttribute(k: string, v: unknown) {
      attrs[k] = v;
      return this;
    },
  } as unknown as Span;
  return { span, attrs };
}

describe("otel/usage", () => {
  it("maps usage/cost/turns onto gen_ai.usage.* attributes", () => {
    const { span, attrs } = fakeSpan();
    setUsageAttributes(span, {
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      total_cost_usd: 0.01,
      num_turns: 2,
    });
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(20);
    expect(attrs["gen_ai.usage.cache_read_input_tokens"]).toBe(5);
    expect(attrs["gen_ai.usage.cost_usd"]).toBe(0.01);
    expect(attrs["agent.turn.count"]).toBe(2);
  });

  it("skips absent fields without throwing", () => {
    const { span, attrs } = fakeSpan();
    setUsageAttributes(span, {});
    expect(Object.keys(attrs)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test otel-usage
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 otel/usage.ts**

`apps/runtime/src/otel/usage.ts`：

```ts
import type { Span } from "@opentelemetry/api";

// result 事件载荷里与用量相关的子集（来自 SDKResultMessage 经 mapMessage）。
export interface ResultUsageData {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
}

// 把本轮 token/费用打到 turn span（gen_ai.usage.*）。第三方端点 cost 可能失真（spec §7.3），
// 仅 token 可信；属性照打，解读由后端/看板负责。
export function setUsageAttributes(span: Span, d: ResultUsageData): void {
  const u = d.usage ?? {};
  if (u.input_tokens != null) span.setAttribute("gen_ai.usage.input_tokens", u.input_tokens);
  if (u.output_tokens != null) span.setAttribute("gen_ai.usage.output_tokens", u.output_tokens);
  if (u.cache_read_input_tokens != null)
    span.setAttribute("gen_ai.usage.cache_read_input_tokens", u.cache_read_input_tokens);
  if (u.cache_creation_input_tokens != null)
    span.setAttribute("gen_ai.usage.cache_creation_input_tokens", u.cache_creation_input_tokens);
  if (d.total_cost_usd != null) span.setAttribute("gen_ai.usage.cost_usd", d.total_cost_usd);
  if (d.num_turns != null) span.setAttribute("agent.turn.count", d.num_turns);
}
```

- [ ] **Step 4: 跑测试确认通过 + biome + commit**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test otel-usage
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 exec biome check apps/runtime/src/otel/usage.ts apps/runtime/test/otel-usage.test.ts
git add apps/runtime/src/otel/usage.ts apps/runtime/test/otel-usage.test.ts
git commit -m "feat(otel): SDKResultMessage 用量/费用 → gen_ai.usage.* 属性"
```

---

## Task 4: runtime.ts 接入 span 生命周期 + traceId 透出

**Files:**
- Modify: `apps/runtime/src/agent/runtime.ts`
- Test: `apps/runtime/test/runtime.test.ts`（追加 span/traceId 断言）

- [ ] **Step 1: 追加 runtime span 单测（先失败）**

在 `apps/runtime/test/runtime.test.ts` 顶部加 imports，并在 `describe("runTurn", ...)` 内追加一个嵌套 describe。先加 imports（与现有 import 合并，勿重复）：

```ts
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach } from "vitest";
```

再在文件末尾 `describe("runTurn", ...)` 之后追加：

```ts
describe("runTurn telemetry", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("emits a turn span with a nested tool span and usage attributes", async () => {
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(sampleMessages))) {
      // drain
    }
    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "agent.turn");
    const tool = spans.find((s) => s.name === "tool:Bash");
    expect(turn).toBeDefined();
    expect(tool?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
    expect(turn?.attributes["gen_ai.conversation.id"]).toBe("sess-1");
    expect(turn?.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(turn?.attributes["gen_ai.usage.output_tokens"]).toBe(20);
  });

  it("adds traceId to init and result events and injects TRACEPARENT into child env", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {
        for (const m of sampleMessages) yield m;
      })();
    };
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, capturing)) {
      events.push(e);
    }
    const init = events.find((e) => e.event === "init");
    const result = events.find((e) => e.event === "result");
    const traceId = init?.data.traceId as string;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(result?.data.traceId).toBe(traceId);
    // TRACEPARENT 注入子 env，且其 trace-id 与本轮一致
    expect(captured?.env?.TRACEPARENT).toContain(traceId);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test runtime
```
预期：FAIL（无 span 产生 / init 无 traceId / env 无 TRACEPARENT）。

- [ ] **Step 3: 改 runtime.ts**

在 `apps/runtime/src/agent/runtime.ts`：

(a) 顶部 import 增加（与现有合并）：

```ts
import { isSpanContextValid, type Span, SpanStatusCode } from "@opentelemetry/api";
import { startToolSpan, startTurnSpan, traceparentOf } from "../otel/spans.js";
import { setUsageAttributes } from "../otel/usage.js";
```

(b) 把 `runTurn` 整体替换为（保留原 options 字段，新增 span 接线）：

```ts
export async function* runTurn(
  input: RunTurnInput,
  cfg: RuntimeConfig,
  queryFn: QueryFn = defaultQuery,
): AsyncGenerator<SseEvent> {
  const span = startTurnSpan({
    model: input.model ?? cfg.defaultModel,
    resumeId: input.resumeId,
  });
  const sc = span.spanContext();
  const traceId = isSpanContextValid(sc) ? sc.traceId : undefined;
  const toolSpans = new Map<string, Span>();

  const env = buildChildEnv(cfg);
  // 仅当 span context 有效（已起真实 TracerProvider）才注入 TRACEPARENT，避免给子 CLI 喂全零 id。
  if (traceId) env.TRACEPARENT = traceparentOf(span);

  const options: Options = {
    cwd: cfg.cwd,
    model: input.model ?? cfg.defaultModel,
    effort: cfg.effort,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: ["Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)", "Bash(rm -rf:*)"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    includePartialMessages: cfg.includePartial,
    env,
    abortController: input.abortController,
    ...(cfg.claudeCliPath ? { pathToClaudeCodeExecutable: cfg.claudeCliPath } : {}),
    ...(input.resumeId ? { resume: input.resumeId } : {}),
  };

  try {
    for await (const m of queryFn({ prompt: input.prompt, options })) {
      const evt = mapMessage(m);
      if (!evt) continue;

      switch (evt.event) {
        case "init":
          span.setAttribute("gen_ai.conversation.id", String(evt.data.sessionId));
          break;
        case "assistant":
          for (const t of (evt.data.toolUses ?? []) as Array<{ id: string; name: string }>) {
            toolSpans.set(t.id, startToolSpan(span, { name: t.name, id: t.id }));
          }
          break;
        case "tool_result":
          for (const r of (evt.data.results ?? []) as Array<{
            toolUseId: string;
            isError: boolean;
          }>) {
            const ts = toolSpans.get(r.toolUseId);
            if (ts) {
              if (r.isError) ts.setStatus({ code: SpanStatusCode.ERROR });
              ts.end();
              toolSpans.delete(r.toolUseId);
            }
          }
          break;
        case "result":
          setUsageAttributes(span, evt.data);
          break;
        case "error":
          span.setStatus({ code: SpanStatusCode.ERROR });
          break;
      }

      if (traceId && (evt.event === "init" || evt.event === "result")) {
        evt.data = { ...evt.data, traceId };
      }
      yield evt;
    }
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    for (const ts of toolSpans.values()) ts.end(); // 收尾未配对的 tool span
    span.end();
  }
}
```

> 说明：abort 时 `queryFn` 抛错 → 进 catch → 记录异常 + ERROR 状态 → rethrow（sessions.ts 据 `abortController.signal.aborted` 区分 aborted/error，行为不变）。`finally` 确保 span 一定 end。

- [ ] **Step 4: 跑全套 runtime 测试确认通过**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test runtime
```
预期：原有 8 + 新增 2 全 PASS。原有断言用 `toMatchObject`/`toEqual`(events 名数组) 不受 `traceId` 影响（无 provider 时不加 traceId；有 provider 的新测试单独建栈）。

- [ ] **Step 5: typecheck + biome + commit**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 exec biome check apps/runtime/src/agent/runtime.ts apps/runtime/test/runtime.test.ts
git add apps/runtime/src/agent/runtime.ts apps/runtime/test/runtime.test.ts
git commit -m "feat(otel): runTurn 包 turn/tool span、注 TRACEPARENT、result usage、init/result 透出 traceId"
```

---

## Task 5: X-Trace-Id 响应头 + CORS 暴露

**Files:**
- Modify: `apps/runtime/src/routes/sessions.ts`（streamTurn 预读 init 后设头）
- Modify: `apps/runtime/src/server.ts`（CORS exposeHeaders）
- Test: `apps/runtime/test/routes-sse.test.ts`（追加 1 个用例）

- [ ] **Step 1: 追加 SSE 头单测（先失败）**

在 `apps/runtime/test/routes-sse.test.ts` 顶部加 imports：

```ts
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach } from "vitest";
```

在 `describe("SSE routes", ...)` 内追加：

```ts
describe("with telemetry active", () => {
  let provider: BasicTracerProvider;

  beforeEach(() => {
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("sets X-Trace-Id response header matching the init event traceId", async () => {
    const { app } = makeApp();
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    const header = res.headers.get("X-Trace-Id");
    expect(header).toMatch(/^[0-9a-f]{32}$/);
    const text = await res.text();
    expect(text).toContain(`"traceId":"${header}"`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test routes-sse
```
预期：FAIL（无 X-Trace-Id 头）。

- [ ] **Step 3: 改 streamTurn 设头**

在 `apps/runtime/src/routes/sessions.ts` 的 `streamTurn`：在预读 init 成功（拿到 `firstEvt`）之后、`return streamSSE(...)` 之前，加设头逻辑。具体：把现有

```ts
      if (firstEvt.event === "init") {
        sid = String(firstEvt.data.sessionId);
        deps.registry.startTurn(sid, {
          model: input.model ?? deps.config.defaultModel,
          abortController,
        });
      }
```

改为：

```ts
      if (firstEvt.event === "init") {
        sid = String(firstEvt.data.sessionId);
        deps.registry.startTurn(sid, {
          model: input.model ?? deps.config.defaultModel,
          abortController,
        });
      }
      // 把本轮 traceId 透出到响应头（前端可据此深链 Jaeger；需 CORS exposeHeaders）。
      const traceId = firstEvt.data.traceId;
      if (typeof traceId === "string") c.header("X-Trace-Id", traceId);
```

> 说明：`c.header()` 在 `return streamSSE(c, ...)` 之前调用，Hono 会把它并入 SSE 响应头。

- [ ] **Step 4: server.ts CORS 暴露 X-Trace-Id**

把 `apps/runtime/src/server.ts` 的 cors 配置改为：

```ts
  app.use(
    "*",
    cors({
      origin: config.corsOrigins === "*" ? "*" : config.corsOrigins.split(",").map((s) => s.trim()),
      exposeHeaders: ["X-Trace-Id"],
    }),
  );
```

- [ ] **Step 5: 跑测试确认通过**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test routes-sse
```
预期：原有 5 + 新增 1 全 PASS。

- [ ] **Step 6: 全量 runtime 测试 + typecheck + biome + commit**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 exec biome check apps/runtime/src/routes/sessions.ts apps/runtime/src/server.ts apps/runtime/test/routes-sse.test.ts
git add apps/runtime/src/routes/sessions.ts apps/runtime/src/server.ts apps/runtime/test/routes-sse.test.ts
git commit -m "feat(otel): SSE 响应头透出 X-Trace-Id + CORS exposeHeaders"
```

---

## Task 6: 后端栈（docker-compose + collector + prometheus）

**Files:**
- Create: `docker-compose.yml`（仓库根）
- Create: `otel/collector-config.yaml`
- Create: `otel/prometheus.yml`
- Modify: `.env.example`（补 OTEL 注释）
- Modify: `apps/runtime/Dockerfile`（无需改 —— 见说明；本 Task 不改它）

- [ ] **Step 1: 写 collector 配置**

`otel/collector-config.yaml`：

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  # 转发 trace 到 Jaeger（Jaeger all-in-one 开 OTLP gRPC 4317）
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  # 暴露 metrics 给 Prometheus 抓取
  prometheus:
    endpoint: 0.0.0.0:8889
  # logs 落到 collector 自身日志（spec §3.3 OTEL_LOGS_EXPORTER=otlp 的接收端）
  debug:
    verbosity: basic

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

- [ ] **Step 2: 写 prometheus 配置**

`otel/prometheus.yml`：

```yaml
global:
  scrape_interval: 5s

scrape_configs:
  - job_name: otel-collector
    static_configs:
      - targets: ["otel-collector:8889"]
```

- [ ] **Step 3: 写 docker-compose.yml**

仓库根 `docker-compose.yml`：

```yaml
services:
  runtime:
    build:
      context: .
      dockerfile: apps/runtime/Dockerfile
    image: coding-agent-runtime:p2
    env_file: .env
    environment:
      RUNTIME_HOSTNAME: 0.0.0.0
      # —— runtime 自身 NodeSDK（仅 traces）——
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: coding-agent-runtime
      # —— 子 CLI 原生 telemetry（经 buildChildEnv 继承 process.env）——
      CLAUDE_CODE_ENABLE_TELEMETRY: "1"
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1"
      CLAUDE_CODE_PROPAGATE_TRACEPARENT: "1"
      OTEL_TRACES_EXPORTER: otlp
      OTEL_METRICS_EXPORTER: otlp
      OTEL_LOGS_EXPORTER: otlp
      OTEL_METRIC_EXPORT_INTERVAL: "1000"
      OTEL_LOGS_EXPORT_INTERVAL: "1000"
      # —— 前端深链目标（/config 透出）——
      JAEGER_BASE_URL: http://localhost:16686
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./.runtime/workspace:/workspace
      - ./.runtime/claude-config:/claude-config
    depends_on:
      - otel-collector

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.119.0
    command: ["--config=/etc/otelcol/config.yaml"]
    volumes:
      - ./otel/collector-config.yaml:/etc/otelcol/config.yaml:ro
    ports:
      - "127.0.0.1:4318:4318"

  jaeger:
    image: jaegertracing/all-in-one:1.62.0
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    ports:
      - "127.0.0.1:16686:16686"

  prometheus:
    image: prom/prometheus:v2.55.1
    volumes:
      - ./otel/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "127.0.0.1:9090:9090"
```

> 说明（实现者必读）：
> - **不改 Dockerfile**：OTEL/CLAUDE_CODE telemetry env 全部放 compose 的 `environment`，使裸 `docker run`（无 collector）保持干净（telemetry 自动 off）。
> - 挂载目录 `./.runtime/workspace`、`./.runtime/claude-config` 首次需存在且 chown 到容器 UID/GID 10001（bind mount 坑）：`mkdir -p .runtime/workspace .runtime/claude-config`。compose 起容器后由 entrypoint 写 CLAUDE.md。Windows 下 bind mount 权限交给 Docker Desktop，无需手动 chown。
> - `.runtime/` 应加入 `.gitignore`（运行态产物，勿提交）。

- [ ] **Step 4: 补 .gitignore + .env.example**

在仓库根 `.gitignore` 末尾追加（若无该行）：

```
.runtime/
```

在 `.env.example` 的「服务自身」段落补注释（紧跟 `JAEGER_BASE_URL=` 行之后）：

```bash
# ---- OTel（仅 docker-compose 起栈时生效；裸 docker run 不设 OTEL_EXPORTER_OTLP_ENDPOINT 则 telemetry 自动 off）----
# 这些由 docker-compose.yml 注入，无需在 .env 配置；列此仅作说明：
#   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
#   CLAUDE_CODE_ENABLE_TELEMETRY=1 / CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 / CLAUDE_CODE_PROPAGATE_TRACEPARENT=1
```

- [ ] **Step 5: 校验 compose 配置语法**

```bash
mkdir -p .runtime/workspace .runtime/claude-config
docker compose config
```
预期：打印规整后的合并配置、无 YAML/字段错误（此步不起容器）。

- [ ] **Step 6: commit**

```bash
git add docker-compose.yml otel/collector-config.yaml otel/prometheus.yml .env.example .gitignore
git commit -m "feat(otel): docker-compose 后端栈（Collector+Jaeger+Prometheus）+ collector/prometheus 配置"
```

---

## Task 7: web —— trace 深链

**Files:**
- Create: `apps/web/src/lib/trace.ts`
- Create: `apps/web/src/lib/trace.test.ts`
- Modify: `apps/web/src/components/ChatPanel.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: 写 traceUrl 纯函数单测（先失败）**

`apps/web/src/lib/trace.test.ts`（web 用 Bundler 解析，import 不带扩展名）：

```ts
import { describe, expect, it } from "vitest";
import { traceUrl } from "./trace";

describe("traceUrl", () => {
  it("builds a Jaeger deep link", () => {
    expect(traceUrl("http://localhost:16686", "abc123")).toBe(
      "http://localhost:16686/trace/abc123",
    );
  });

  it("trims a trailing slash on the base", () => {
    expect(traceUrl("http://localhost:16686/", "abc")).toBe("http://localhost:16686/trace/abc");
  });

  it("returns null when base or traceId is missing", () => {
    expect(traceUrl(null, "abc")).toBeNull();
    expect(traceUrl("http://x", undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web test trace
```
预期：FAIL（`./trace` 不存在）。

- [ ] **Step 3: 实现 trace.ts**

`apps/web/src/lib/trace.ts`：

```ts
// Jaeger 深链：<jaegerBaseUrl>/trace/<traceId>。base 或 traceId 缺失返回 null（不渲染链接）。
export function traceUrl(jaegerBaseUrl: string | null, traceId: string | undefined): string | null {
  if (!jaegerBaseUrl || !traceId) return null;
  return `${jaegerBaseUrl.replace(/\/$/, "")}/trace/${traceId}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web test trace
```
预期：PASS（3 tests）。

- [ ] **Step 5: ChatPanel 接 traceId + 渲染深链**

改 `apps/web/src/components/ChatPanel.tsx`：

(a) import 增加：

```ts
import { traceUrl } from "../lib/trace";
```

(b) `Props` 增加 `jaegerBaseUrl`：

```ts
interface Props {
  baseUrl: string;
  model: string | undefined;
  jaegerBaseUrl: string | null;
}

export function ChatPanel({ baseUrl, model, jaegerBaseUrl }: Props) {
```

(c) 组件内加 state 记录最近一轮 traceId：

```ts
  const [lastTraceId, setLastTraceId] = useState<string | undefined>(undefined);
```

(d) 在 `send()` 解析事件处，`init` 与 `result` 分支里捕获 traceId（紧接现有 `if (evt.event === "init")` 块内、设 sessionId 之后加一行；`result` 分支同理）：

init 分支内加：

```ts
          if (data.traceId) setLastTraceId(String(data.traceId));
```

result 分支内（push result 行之后）加：

```ts
          if (data.traceId) setLastTraceId(String(data.traceId));
```

(e) 在 `chat-actions` 的 `<span className="sid">…</span>` 之后追加深链：

```tsx
          {(() => {
            const url = traceUrl(jaegerBaseUrl, lastTraceId);
            return url ? (
              <a className="trace-link" href={url} target="_blank" rel="noreferrer">
                在 Jaeger 打开 trace
              </a>
            ) : null;
          })()}
```

- [ ] **Step 6: App.tsx 传 jaegerBaseUrl**

改 `apps/web/src/App.tsx` 里渲染 ChatPanel 处：

```tsx
          {tab === "chat" ? (
            <ChatPanel baseUrl={baseUrl} model={model} jaegerBaseUrl={cfg.jaegerBaseUrl} />
          ) : (
            <SpecPanel baseUrl={baseUrl} />
          )}
```

- [ ] **Step 7: typecheck + biome + 全量 web 测试 + commit**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web test
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 exec biome check apps/web/src/lib/trace.ts apps/web/src/lib/trace.test.ts apps/web/src/components/ChatPanel.tsx apps/web/src/App.tsx
git add apps/web/src/lib/trace.ts apps/web/src/lib/trace.test.ts apps/web/src/components/ChatPanel.tsx apps/web/src/App.tsx
git commit -m "feat(web): 对话面板按 traceId 深链 Jaeger"
```

---

## Task 8: 端到端真实验收（compose + MiniMax + Jaeger）

> 这是 P2 的验收门槛（spec §12）。非 TDD，手动验证；保留证据。

- [ ] **Step 1: 准备 .env 与挂载目录**

确认仓库根 `.env` 含 `ANTHROPIC_BASE_URL`（MiniMax `/anthropic`）、`ANTHROPIC_API_KEY`、`RUNTIME_DEFAULT_MODEL=MiniMax-M3`。建挂载目录：

```bash
mkdir -p .runtime/workspace .runtime/claude-config
```

- [ ] **Step 2: 起全栈**

```bash
docker compose up -d --build
docker compose ps
```
预期：runtime/otel-collector/jaeger/prometheus 四个服务 Up。

- [ ] **Step 3: 健康检查 + 发一轮带工具的对话**

```bash
curl -sS --noproxy '*' http://127.0.0.1:8080/healthz
curl -sS --noproxy '*' -D - -X POST http://127.0.0.1:8080/sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"创建文件 p2.txt，写入一行：otel ok"}' --max-time 120
```
预期：响应头含 `X-Trace-Id: <32hex>`；SSE 流含 `init`(带 `traceId`)、`assistant`(Write tool_use)、`tool_result`、`result`(带 `traceId` 与 usage)。记下 `X-Trace-Id`。

- [ ] **Step 4: 在 Jaeger 看链路**

浏览器开 `http://127.0.0.1:16686`，按 service `coding-agent-runtime` 查最近 trace，或直接 `http://127.0.0.1:16686/trace/<X-Trace-Id>`。
预期：看到 `agent.turn`（root，SpanKind SERVER）→ `tool:Write` 子 span；若 CLI enhanced-telemetry 生效，还挂有 `claude_code.*`（如 `llm_request`）子 span。turn span 属性含 `gen_ai.conversation.id`、`gen_ai.usage.input_tokens/output_tokens/cost_usd`、`agent.turn.count`。
> 若只见 `agent.turn`+`tool:*` 而无 `claude_code.*`：对照 spec §13 开放问题 #2/#3/#4（CLI 在 stream-json 路径下的 span 缺口、TRACEPARENT 是否被采纳）。记录现象；P2 验收以「自建 turn→tool 链路 + token 属性可见」为底线，CLI 原生子 span 为加分项（取决于 pin 的 CLI 版本行为）。

- [ ] **Step 5: 验 web 深链**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web dev -- --host 127.0.0.1
```
浏览器开 `http://127.0.0.1:5173/`，连接 `http://127.0.0.1:8080` → 对话 → 一轮结束后点「在 Jaeger 打开 trace」→ 跳到对应 trace。

- [ ] **Step 6: 验 Prometheus（可选加分）**

开 `http://127.0.0.1:9090`，查询 `claude_code_token_usage_tokens_total` 或 collector 暴露的任一指标，确认 metrics 通到 Prometheus。

- [ ] **Step 7: 收尾**

```bash
docker compose down
```
记录验收结论（trace 截图 / 关键属性）。

---

## Task 9: 合并到 main

- [ ] **Step 1: 全量门槛复跑**

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 -r run test
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 exec biome check .
```
预期：全绿。

- [ ] **Step 2: --no-ff 合并（保留特性分支，与 P0/P1 一致）**

```bash
git checkout main
git merge --no-ff feat/p2-otel-observability -m "merge: P2 OTel 可观测性 + 界面 trace（turn/tool span + TRACEPARENT + usage→span + compose 栈 + X-Trace-Id + web 深链）"
git log --oneline -3
```

- [ ] **Step 3: 用 superpowers:finishing-a-development-branch 收尾**

按该技能处理分支保留/清理与最终核对。

---

## 自检（写完计划后的核对）

**1. Spec 覆盖（§7 / §3.3 / §4.2 / §5 / §9 / §12 P2 行）：**
- 自建 `agent.turn` span（SpanKind.SERVER）→ Task 2/4 ✅
- `agent.session`：本计划用 `gen_ai.conversation.id = sessionId` 属性做跨轮归并（spec §7.1 明列此法），**不**单建长生命周期 session span（无状态每轮、span 不能跨进程长持有）。这是对 spec「session span」的合理落地，已在 Task 4 注释说明。
- TRACEPARENT 注入 `options.env` → Task 4 ✅
- 工具树（tool_use/tool_result 配对）→ Task 4 ✅
- usage/cost → `gen_ai.usage.*` → Task 3/4 ✅
- compose（Collector+Jaeger+Prometheus）→ Task 6 ✅
- SSE `init`/`result` 带 traceId + 响应头 `X-Trace-Id` → Task 4/5 ✅
- web 深链 → Task 7 ✅
- 端到端验收 → Task 8 ✅

**2. 占位符扫描：** 无 TBD/TODO；每个改代码步骤都给了完整代码与确切命令/预期。Task 6 的外部镜像 tag 为具体版本（可按需 bump，已注明）。

**3. 类型一致：** `startTurnSpan`/`startToolSpan`/`traceparentOf`/`setUsageAttributes`/`startTelemetry`/`getTracer`/`shutdownTelemetry` 在定义（Task 1-3）与调用（Task 4-5、index.ts）处签名一致；`ResultUsageData` 与 mapMessage 的 result 事件载荷字段对齐；web `traceUrl(jaegerBaseUrl, traceId)` 在 trace.ts 定义、ChatPanel 调用一致。

**4. 歧义：** telemetry 门控、TRACEPARENT 仅在 span 有效时注入、session span 落地为属性归并 —— 均在对应 Task 注释中明确。

# Coding Agent Runtime — P1（多轮 + 会话 + 界面骨架）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0 单轮骨架上落地多轮 resume、Session Registry、`/sessions/*` 全套 REST + SSE、OpenAPI 3.1 + Swagger UI + CORS、model 白名单，以及独立 `apps/web` Playground（连接 + 看 spec + 多轮对话）。

**Architecture:** runtime 服务从普通 `Hono` 升级为 `OpenAPIHono`（`@hono/zod-openapi`），Zod 为唯一 schema 源、`doc31` 出 OpenAPI 3.1、`@hono/swagger-ui` 挂 `/docs`、`hono/cors` 放开跨域。会话状态用进程内 `SessionRegistry`（轮次/累计 token/费用/状态/改动文件/AbortController）做运行态视图，transcript/列表/删除走 SDK 的 `getSessionMessages`/`getSessionInfo`/`listSessions`/`deleteSession`（按 `CLAUDE_CONFIG_DIR` 读挂载盘，容器无状态的持久真相在盘上）。多轮靠 `query({ resume })`，`/stop` 靠 `Options.abortController`。`apps/web` 是独立 Vite+React 单页，用 fetch+ReadableStream 消费 SSE。

**Tech Stack:** TypeScript（NodeNext ESM，严格）；`@anthropic-ai/claude-agent-sdk@0.3.161`；`hono@4.12.23` + `@hono/zod-openapi@^1.4.0` + `@hono/swagger-ui@^0.6.1` + `zod@^4.4.3`；web：`react@19.2.7` + `vite@^7.3.5` + `@vitejs/plugin-react@^5.2.0` + `vitest@^3.2.6`；pnpm workspace（`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 <args>`）；Biome 2.4.16。

---

## 已验证的关键事实（实现前必读）

- **SDK 已安装并导出**：`query`、`listSessions`、`getSessionInfo`、`getSessionMessages`、`deleteSession` 均从 `@anthropic-ai/claude-agent-sdk` 主入口导出。
- **`Options.abortController?: AbortController`**：abort 后 query 停止并清理。`query()` 返回的 `Query.interrupt()` 仅 streaming-input 模式可用，单 string prompt 不可用 → `/stop` **必须**走 `abortController`，不要用 `interrupt()`。
- **`Options.resume?: string`**：多轮续写；`cwd` 必须恒为 `/workspace`（transcript 目录由 cwd 编码）。
- **SDK session 助手按 `CLAUDE_CONFIG_DIR` 解析**（未设则 `~/.claude/projects`）。容器内 Node 父进程由 Dockerfile `ENV CLAUDE_CONFIG_DIR=/claude-config` 提供，故 `getSessionMessages(id, { dir: '/workspace' })` 能读到 `/claude-config/projects/<encoded-/workspace>/<id>.jsonl`。
- **类型形状**（来自 `sdk.d.ts`）：
  - `SDKSessionInfo = { sessionId: string; summary: string; lastModified: number; fileSize?: number; customTitle?: string; firstPrompt?: string; gitBranch?: string; cwd?: string; tag?: string; createdAt?: number }`
  - `SessionMessage = { type: 'user'|'assistant'|'system'; uuid: string; session_id: string; message: unknown; parent_tool_use_id: string|null }`
  - `getSessionInfo(id, { dir? }) => Promise<SDKSessionInfo | undefined>`；`getSessionMessages(id, { dir?, limit?, offset?, includeSystemMessages? }) => Promise<SessionMessage[]>`；`deleteSession(id, { dir? }) => Promise<void>`；`listSessions({ dir?, limit?, offset? }) => Promise<SDKSessionInfo[]>`
- **`@hono/zod-openapi@1.4.0`**：`new OpenAPIHono()`、`createRoute({...})`、`app.openapi(route, handler)`、`app.openAPIRegistry.registerPath({ method, path, request, responses })`、`app.doc31(path, { openapi:'3.1.0', info })`、`import { z } from '@hono/zod-openapi'`（用它导出的 `z`，带 `.openapi()`）。peer：hono ≥4.10（有 4.12.23 ✓）、zod ^4（用 4.4.3 ✓）。
- **`@hono/swagger-ui@0.6.1`**：`import { swaggerUI } from '@hono/swagger-ui'; app.get('/docs', swaggerUI({ url: '/openapi.json' }))`。
- **SSE + OpenAPI 取舍**：SSE 端点用普通 `app.post(...)` + `streamSSE`（OpenAPIHono 继承 Hono，普通路由可用），并用 `app.openAPIRegistry.registerPath()` 手动登记到 `/openapi.json`（OpenAPI 3.1 表达不了连续流，按 spec §4.3 只描述**单事件**载荷）。这样既保留干净的流式实现、又有完整 spec 覆盖。
- **web 栈版本固定**（避免 vite8/rolldown 与 vitest3 冲突）：`vite@^7.3.5` + `@vitejs/plugin-react@^5.2.0` + `vitest@^3.2.6` + `react@19.2.7`。web 用 `moduleResolution: Bundler`，**import 不带 `.js` 扩展**（与 runtime 的 NodeNext 相反）。

## 范围与取舍（YAGNI / 对齐 spec）

- **`/stop` 在 P1 真实接线**：`AbortController` 存进 registry，`/stop` 调 `abort()`。spec §12 P3 的 "abort 接线" 在此读为更强的韧性（断线重连/心跳/工具执行中优雅中止边界），核心接线随 `/stop` 端点落 P1（端点本身就在 P1 的 "`/sessions/*` 全套" 里）。
- **`/sessions/:id/transcript` 不分页面向 UI**：返回 `getSessionMessages` 全量（spec §4.1）。
- **改动文件（changedFiles）尽力而为**：从 assistant 的 `tool_use`（`Write`/`Edit`/`MultiEdit`/`NotebookEdit` 的 `file_path`/`notebook_path`）提取（spec §4.1 列了该字段）。
- **web 看 spec = 内嵌 runtime 的 `/docs`（iframe）+ 直链**：解决 spec 开放问题 #6 朝 "复用 runtime /docs"（P1 不引入 `@scalar`，CLAUDE.md 简单优先）。
- **web 会话列表/选择**：P1 仅做 "保留当前 sessionId 多轮 + 新建（清空）"，**不做**历史会话选择面板（runtime 的 `GET /sessions` 仍完整实现，属 "`/sessions/*` 全套"）。
- **OTel/trace 深链**：属 P2，本期 web 不做 trace 区。
- **不破坏的 P0 锁定项**：无 HTTP 鉴权；`permissionMode:'bypassPermissions'` + `allowDangerouslySkipPermissions:true`；`options.env` 整体 spread `process.env`；`disallowedTools` 兜底 deny 保留。

## 文件结构

```
apps/runtime/
  package.json                 # + @hono/zod-openapi @hono/swagger-ui zod
  src/
    agent/config.ts            # + allowedModels, corsOrigins, isModelAllowed()
    agent/runtime.ts           # + abortController 透传（RunTurnInput）
    agent/session-store.ts     # 新增：SessionRegistry + extractChangedFiles()
    schemas/sessions.ts        # 新增：Zod schema（请求/响应/会话/transcript/错误）
    schemas/events.ts          # 新增：SSE 单事件载荷 schema（仅供 OpenAPI 文档）
    routes/sessions.ts         # 新增：registerSessionRoutes(app, deps) —— SSE + REST
    server.ts                  # 改为 OpenAPIHono：CORS + healthz/config + 挂路由 + doc31 + swaggerUI
    index.ts                   # 基本不变（createServer 内部默认 registry/sdk）
  test/
    config.test.ts             # + allowlist/cors/isModelAllowed
    session-store.test.ts      # 新增
    runtime.test.ts            # + abortController 透传
    schemas.test.ts            # 新增
    routes-sse.test.ts         # 新增：SSE 端点 + registry + 白名单 + 404
    routes-rest.test.ts        # 新增：REST 端点（注入假 SDK）
    server.test.ts             # 重写：OpenAPIHono（openapi.json/docs/cors/healthz/config/端到端）
    helpers.ts                 # testConfig + 假 SDK/registry 辅助
apps/web/                      # 新增独立包 @app/web
  package.json  vite.config.ts  vitest.config.ts  tsconfig.json  index.html
  src/
    main.tsx  App.tsx  styles.css
    lib/sse.ts                 # SSE 解析（纯函数，可测）
    lib/api.ts                 # runtime HTTP 客户端
    lib/sse.test.ts            # 新增
    components/ConnectionBar.tsx  components/ChatPanel.tsx  components/SpecPanel.tsx
.env.example                   # + RUNTIME_ALLOWED_MODELS, CORS_ORIGINS
package.json (root)            # + dev:web 脚本
pnpm-lock.yaml                 # 各加依赖任务后更新并提交
```

---

## Task 1: 依赖 + config（model 白名单 / CORS origins）

**Files:**
- Modify: `apps/runtime/package.json`
- Modify: `apps/runtime/src/agent/config.ts`
- Modify: `apps/runtime/test/config.test.ts`
- Modify: `apps/runtime/test/helpers.ts`
- Modify: `pnpm-lock.yaml`（由 pnpm install 生成）

- [ ] **Step 1: 加依赖到 runtime package.json**

在 `apps/runtime/package.json` 的 `"dependencies"` 中加入（保持现有 SDK/hono/node-server 不动，按仓库惯例 deps 钉精确版本）：

```json
    "@anthropic-ai/claude-agent-sdk": "0.3.161",
    "@hono/node-server": "2.0.4",
    "@hono/swagger-ui": "0.6.1",
    "@hono/zod-openapi": "1.4.0",
    "hono": "4.12.23",
    "zod": "4.4.3"
```

- [ ] **Step 2: 安装并更新锁文件**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 install`
Expected: 成功；`pnpm-lock.yaml` 更新含上述包；无 peer 冲突（zod-openapi 要 hono≥4.10 / zod^4，已满足）。

- [ ] **Step 3: 写失败测试（config 白名单 + cors + isModelAllowed）**

在 `apps/runtime/test/config.test.ts` 追加/调整。先在 "parses env into a RuntimeConfig" 用例的输入里加 `RUNTIME_ALLOWED_MODELS: "MiniMax-M3, claude-x"` 与 `CORS_ORIGINS: "http://localhost:5173"`，并把期望对象改为包含新字段：

```ts
    expect(cfg).toEqual({
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
      defaultModel: "MiniMax-M3",
      allowedModels: ["MiniMax-M3", "claude-x"],
      includePartial: true,
      jaegerBaseUrl: "http://localhost:16686",
      corsOrigins: "http://localhost:5173",
      port: 8080,
      cwd: "/workspace",
      hostname: "0.0.0.0",
    });
```

在 defaults 用例追加断言：

```ts
    expect(cfg.allowedModels).toBeUndefined();
    expect(cfg.corsOrigins).toBe("*");
```

并新增 isModelAllowed 用例：

```ts
import { isModelAllowed, loadConfig } from "../src/agent/config.js";

describe("isModelAllowed", () => {
  it("allows any model when allowlist is undefined or empty", () => {
    expect(isModelAllowed("anything", undefined)).toBe(true);
    expect(isModelAllowed("anything", [])).toBe(true);
  });
  it("allows omitted model (uses configured default)", () => {
    expect(isModelAllowed(undefined, ["MiniMax-M3"])).toBe(true);
  });
  it("enforces the allowlist for explicit models", () => {
    expect(isModelAllowed("MiniMax-M3", ["MiniMax-M3"])).toBe(true);
    expect(isModelAllowed("gpt-4", ["MiniMax-M3"])).toBe(false);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test`
Expected: FAIL（RuntimeConfig 无 allowedModels/corsOrigins，isModelAllowed 未定义）。

- [ ] **Step 5: 实现 config.ts**

把 `apps/runtime/src/agent/config.ts` 改为：

```ts
export interface RuntimeConfig {
  anthropicBaseUrl: string | undefined;
  anthropicApiKey: string;
  defaultModel: string | undefined;
  allowedModels: string[] | undefined;
  includePartial: boolean;
  jaegerBaseUrl: string | undefined;
  corsOrigins: string;
  port: number;
  cwd: string;
  hostname: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  const allowedRaw = env.RUNTIME_ALLOWED_MODELS;
  const allowedModels = allowedRaw
    ? allowedRaw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : undefined;
  return {
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    anthropicApiKey,
    defaultModel: env.RUNTIME_DEFAULT_MODEL || undefined,
    allowedModels,
    includePartial: env.INCLUDE_PARTIAL_MESSAGES === "1",
    jaegerBaseUrl: env.JAEGER_BASE_URL || undefined,
    corsOrigins: env.CORS_ORIGINS || "*",
    port: Number(env.PORT) || 8080,
    cwd: env.RUNTIME_CWD || "/workspace",
    // 安全默认：仅绑回环；非隔离部署不会静默暴露。容器内由 Dockerfile 显式设 0.0.0.0（docker -p 需要）。
    hostname: env.RUNTIME_HOSTNAME || "127.0.0.1",
  };
}

// 仅校验"显式请求的模型"：未配置白名单 → 放行；未指定模型（走默认）→ 放行。
export function isModelAllowed(
  model: string | undefined,
  allowed: string[] | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!model) return true;
  return allowed.includes(model);
}
```

- [ ] **Step 6: 更新 helpers.ts 的 testConfig**

在 `apps/runtime/test/helpers.ts` 的 `testConfig` 中加入新字段：

```ts
export const testConfig: RuntimeConfig = {
  anthropicApiKey: "sk-test",
  anthropicBaseUrl: undefined,
  defaultModel: "MiniMax-M3",
  allowedModels: undefined,
  includePartial: false,
  jaegerBaseUrl: undefined,
  corsOrigins: "*",
  port: 8080,
  cwd: "/workspace",
  hostname: "127.0.0.1",
};
```

- [ ] **Step 7: 运行测试确认通过 + 全量检查**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: 测试通过；typecheck exit 0；biome exit 0。

- [ ] **Step 8: 提交**

```bash
git add apps/runtime/package.json apps/runtime/src/agent/config.ts apps/runtime/test/config.test.ts apps/runtime/test/helpers.ts pnpm-lock.yaml
git commit -m "feat(config): model 白名单 + CORS origins + 加 zod-openapi/swagger-ui 依赖"
```

---

## Task 2: Session Registry（`agent/session-store.ts`）

**Files:**
- Create: `apps/runtime/src/agent/session-store.ts`
- Create: `apps/runtime/test/session-store.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/test/session-store.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { extractChangedFiles, SessionRegistry } from "../src/agent/session-store.js";

function fixedClock(start = 1000): () => number {
  let t = start;
  return () => (t += 1);
}

describe("SessionRegistry", () => {
  it("creates a record on first turn and increments turns on subsequent turns", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "MiniMax-M3", abortController: new AbortController() });
    let rec = reg.get("s1");
    expect(rec?.turns).toBe(1);
    expect(rec?.status).toBe("running");
    expect(rec?.model).toBe("MiniMax-M3");
    reg.finishTurn("s1", "idle");
    reg.startTurn("s1", { model: undefined, abortController: new AbortController() });
    rec = reg.get("s1");
    expect(rec?.turns).toBe(2);
    expect(rec?.status).toBe("running");
  });

  it("accumulates usage and cost across turns", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "m", abortController: new AbortController() });
    reg.recordResult("s1", { inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
    reg.recordResult("s1", { inputTokens: 5, outputTokens: 7, costUsd: 0.02 });
    const rec = reg.get("s1");
    expect(rec?.inputTokens).toBe(15);
    expect(rec?.outputTokens).toBe(27);
    expect(rec?.totalCostUsd).toBeCloseTo(0.03);
  });

  it("dedupes changed files", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "m", abortController: new AbortController() });
    reg.trackChangedFiles("s1", ["/workspace/a.txt", "/workspace/a.txt", "/workspace/b.txt"]);
    expect(reg.get("s1")?.changedFiles).toEqual(["/workspace/a.txt", "/workspace/b.txt"]);
  });

  it("abort() aborts the active controller, marks aborted, and returns false when nothing active", () => {
    const reg = new SessionRegistry(fixedClock());
    const ac = new AbortController();
    reg.startTurn("s1", { model: "m", abortController: ac });
    expect(reg.abort("s1")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(reg.get("s1")?.status).toBe("aborted");
    expect(reg.abort("s1")).toBe(false);
    expect(reg.abort("nope")).toBe(false);
  });

  it("finishTurn does not overwrite a non-running status", () => {
    const reg = new SessionRegistry(fixedClock());
    const ac = new AbortController();
    reg.startTurn("s1", { model: "m", abortController: ac });
    reg.abort("s1"); // status -> aborted
    reg.finishTurn("s1", "error");
    expect(reg.get("s1")?.status).toBe("aborted");
  });

  it("list/has/remove behave", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "m", abortController: new AbortController() });
    reg.startTurn("s2", { model: "m", abortController: new AbortController() });
    expect(reg.has("s1")).toBe(true);
    expect(reg.list().map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    reg.remove("s1");
    expect(reg.has("s1")).toBe(false);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("extractChangedFiles", () => {
  it("pulls file paths from edit-family tool uses only", () => {
    const files = extractChangedFiles([
      { name: "Write", input: { file_path: "/workspace/a.txt" } },
      { name: "Edit", input: { file_path: "/workspace/b.txt" } },
      { name: "NotebookEdit", input: { notebook_path: "/workspace/n.ipynb" } },
      { name: "Bash", input: { command: "ls" } },
      { name: "Read", input: { file_path: "/workspace/c.txt" } },
    ]);
    expect(files).toEqual(["/workspace/a.txt", "/workspace/b.txt", "/workspace/n.ipynb"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test session-store`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 session-store.ts**

`apps/runtime/src/agent/session-store.ts`：

```ts
export type SessionStatus = "running" | "idle" | "error" | "aborted";

export interface SessionRecord {
  id: string;
  model: string | undefined;
  status: SessionStatus;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  changedFiles: string[];
  createdAt: number;
  lastActiveAt: number;
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// 尽力而为：从编辑类 tool_use 的 input 提取改动文件路径。
export function extractChangedFiles(
  toolUses: ReadonlyArray<{ name: string; input: unknown }>,
): string[] {
  const files: string[] = [];
  for (const t of toolUses) {
    if (!EDIT_TOOLS.has(t.name)) continue;
    const input = t.input as { file_path?: unknown; notebook_path?: unknown } | null;
    const p =
      typeof input?.file_path === "string"
        ? input.file_path
        : typeof input?.notebook_path === "string"
          ? input.notebook_path
          : undefined;
    if (p) files.push(p);
  }
  return files;
}

// 进程内会话注册表：运行态视图（轮次/累计用量/费用/状态/改动文件 + 活跃轮的 AbortController）。
// 容器无状态 —— 持久真相在挂载盘的 transcript；本表是运行期便利，重启即丢可接受。
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  startTurn(id: string, opts: { model: string | undefined; abortController: AbortController }): void {
    const t = this.now();
    const existing = this.sessions.get(id);
    if (existing) {
      existing.status = "running";
      existing.turns += 1;
      existing.lastActiveAt = t;
      if (opts.model) existing.model = opts.model;
    } else {
      this.sessions.set(id, {
        id,
        model: opts.model,
        status: "running",
        turns: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        changedFiles: [],
        createdAt: t,
        lastActiveAt: t,
      });
    }
    this.active.set(id, opts.abortController);
  }

  recordResult(
    id: string,
    r: { inputTokens: number; outputTokens: number; costUsd: number },
  ): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.totalCostUsd += r.costUsd;
    s.lastActiveAt = this.now();
  }

  trackChangedFiles(id: string, files: string[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const f of files) if (!s.changedFiles.includes(f)) s.changedFiles.push(f);
  }

  finishTurn(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id);
    if (s && s.status === "running") s.status = status;
    this.active.delete(id);
  }

  abort(id: string): boolean {
    const ac = this.active.get(id);
    if (!ac) return false;
    ac.abort();
    const s = this.sessions.get(id);
    if (s) s.status = "aborted";
    this.active.delete(id);
    return true;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.active.delete(id);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test session-store`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/agent/session-store.ts apps/runtime/test/session-store.test.ts
git commit -m "feat(runtime): SessionRegistry 运行态视图 + changedFiles 提取"
```

---

## Task 3: runtime.ts — 透传 abortController

**Files:**
- Modify: `apps/runtime/src/agent/runtime.ts`
- Modify: `apps/runtime/test/runtime.test.ts`

- [ ] **Step 1: 写失败测试**

在 `apps/runtime/test/runtime.test.ts` 的 describe 内追加：

```ts
  it("passes a provided abortController through to query options", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    const ac = new AbortController();
    for await (const _e of runTurn({ prompt: "hi", abortController: ac }, testConfig, capturing)) {
      // drain
    }
    expect(captured?.abortController).toBe(ac);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test runtime`
Expected: FAIL（`abortController` 不在 RunTurnInput / 未透传）。

- [ ] **Step 3: 实现 —— RunTurnInput 加字段并写入 options**

在 `apps/runtime/src/agent/runtime.ts`：

`RunTurnInput` 接口加一行：

```ts
export interface RunTurnInput {
  prompt: string;
  model?: string;
  resumeId?: string;
  abortController?: AbortController;
}
```

在 `runTurn` 的 `options` 对象里，紧挨 `env: buildChildEnv(cfg),` 之后加：

```ts
    env: buildChildEnv(cfg),
    abortController: input.abortController,
    ...(input.resumeId ? { resume: input.resumeId } : {}),
```

（`Options.abortController` 可选，传 `undefined` 无副作用。）

- [ ] **Step 4: 运行确认通过 + 检查**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test runtime && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: PASS；biome exit 0。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/agent/runtime.ts apps/runtime/test/runtime.test.ts
git commit -m "feat(runtime): runTurn 透传 abortController 以支持 /stop"
```

---

## Task 4: Zod schemas（`schemas/sessions.ts` + `schemas/events.ts`）

**Files:**
- Create: `apps/runtime/src/schemas/sessions.ts`
- Create: `apps/runtime/src/schemas/events.ts`
- Create: `apps/runtime/test/schemas.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/test/schemas.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { SseEventSchema } from "../src/schemas/events.js";
import {
  CreateSessionBody,
  ErrorResponse,
  SessionInfo,
  SessionListItem,
} from "../src/schemas/sessions.js";

describe("schemas", () => {
  it("CreateSessionBody requires a non-empty prompt", () => {
    expect(CreateSessionBody.safeParse({ prompt: "hi" }).success).toBe(true);
    expect(CreateSessionBody.safeParse({ prompt: "" }).success).toBe(false);
    expect(CreateSessionBody.safeParse({}).success).toBe(false);
    expect(CreateSessionBody.safeParse({ prompt: "hi", model: "MiniMax-M3" }).success).toBe(true);
  });

  it("SessionListItem accepts a registry record shape", () => {
    const ok = SessionListItem.safeParse({
      id: "s1",
      model: "MiniMax-M3",
      status: "idle",
      turns: 2,
      inputTokens: 10,
      outputTokens: 20,
      totalCostUsd: 0.03,
      changedFiles: ["/workspace/a.txt"],
      createdAt: 1,
      lastActiveAt: 2,
    });
    expect(ok.success).toBe(true);
  });

  it("SessionInfo extends list item with optional disk metadata", () => {
    const r = SessionInfo.safeParse({
      id: "s1",
      model: null,
      status: "running",
      turns: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      changedFiles: [],
      createdAt: 1,
      lastActiveAt: 1,
      summary: "first prompt",
      cwd: "/workspace",
    });
    expect(r.success).toBe(true);
  });

  it("ErrorResponse and SseEventSchema parse", () => {
    expect(ErrorResponse.safeParse({ error: "nope" }).success).toBe(true);
    expect(SseEventSchema.safeParse({ event: "init", data: { sessionId: "s1" } }).success).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test schemas`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 schemas/sessions.ts**

```ts
import { z } from "@hono/zod-openapi";

export const StatusEnum = z.enum(["running", "idle", "error", "aborted"]);

export const CreateSessionBody = z
  .object({
    prompt: z.string().min(1).openapi({ example: "在 /workspace 建一个 hello.txt" }),
    model: z.string().optional().openapi({ example: "MiniMax-M3" }),
  })
  .openapi("CreateSessionBody");

export const TurnBody = z
  .object({
    prompt: z.string().min(1),
    model: z.string().optional(),
  })
  .openapi("TurnBody");

export const SessionListItem = z
  .object({
    id: z.string(),
    model: z.string().nullable(),
    status: StatusEnum,
    turns: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    totalCostUsd: z.number(),
    changedFiles: z.array(z.string()),
    createdAt: z.number(),
    lastActiveAt: z.number(),
  })
  .openapi("SessionListItem");

export const SessionInfo = SessionListItem.extend({
  summary: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
}).openapi("SessionInfo");

export const TranscriptMessage = z
  .object({
    type: z.enum(["user", "assistant", "system"]),
    uuid: z.string(),
    session_id: z.string(),
    message: z.unknown(),
    parent_tool_use_id: z.string().nullable(),
  })
  .openapi("TranscriptMessage");

export const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");
export const StopResponse = z.object({ stopped: z.boolean() }).openapi("StopResponse");
export const DeleteResponse = z.object({ deleted: z.boolean() }).openapi("DeleteResponse");

export const SessionIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "0c1d…" }),
});
```

- [ ] **Step 4: 实现 schemas/events.ts**

```ts
import { z } from "@hono/zod-openapi";

// OpenAPI 3.1 表达不了连续流；按 spec §4.3 只描述"单事件"载荷。
export const SseEventSchema = z
  .object({
    event: z.enum(["init", "assistant", "tool_result", "result", "error", "aborted"]),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("SseEvent");
```

- [ ] **Step 5: 运行确认通过 + 检查**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test schemas && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: PASS；biome exit 0。
> 注：若 `z.record(z.string(), z.unknown())` 在 zod 4 报参数签名问题，用 `z.record(z.string(), z.any())`；二者皆 zod4 合法。

- [ ] **Step 6: 提交**

```bash
git add apps/runtime/src/schemas apps/runtime/test/schemas.test.ts
git commit -m "feat(runtime): Zod schema（会话/transcript/错误/SSE 单事件）作为 OpenAPI 单一来源"
```

---

## Task 5: routes/sessions.ts — SSE 对话端点（POST /sessions、POST /sessions/:id/turns）

**Files:**
- Create: `apps/runtime/src/routes/sessions.ts`
- Create: `apps/runtime/test/routes-sse.test.ts`
- Modify: `apps/runtime/test/helpers.ts`

**说明：** 本任务创建 `registerSessionRoutes(app, deps)` 并先实现两个 SSE 端点 + 共享 `streamTurn` 助手。此时 `server.ts` 仍是 P0 旧版（未挂新路由），新代码先以独立测试验证（测试里自建 `OpenAPIHono` 注册路由），Task 7 再接到 server。

- [ ] **Step 1: 在 helpers.ts 增加 SSE 文本收集工具**

在 `apps/runtime/test/helpers.ts` 末尾追加：

```ts
// 把一次 app.request 的 SSE 响应读成事件名数组 + 原文，便于断言。
export async function collectSse(res: Response): Promise<{ text: string; events: string[] }> {
  const text = await res.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1] as string);
  return { text, events };
}
```

- [ ] **Step 2: 写失败测试 routes-sse.test.ts**

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/agent/session-store.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { collectSse, fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

function makeApp(overrides: Partial<Parameters<typeof registerSessionRoutes>[1]> = {}) {
  const app = new OpenAPIHono();
  const registry = new SessionRegistry();
  registerSessionRoutes(app, {
    config: testConfig,
    queryFn: fakeQueryFn(sampleMessages),
    registry,
    sdk: {},
    version: "test",
    ...overrides,
  });
  return { app, registry };
}

describe("SSE routes", () => {
  it("POST /sessions streams mapped events and registers the session", async () => {
    const { app, registry } = makeApp();
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    const { events } = await collectSse(res);
    expect(events).toEqual(["init", "assistant", "tool_result", "result"]);
    const rec = registry.get("sess-1");
    expect(rec?.turns).toBe(1);
    expect(rec?.status).toBe("idle");
    expect(rec?.inputTokens).toBe(10);
    expect(rec?.outputTokens).toBe(20);
  });

  it("POST /sessions rejects an empty prompt with 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions rejects a disallowed model with 400", async () => {
    const { app } = makeApp({ config: { ...testConfig, allowedModels: ["MiniMax-M3"] } });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", model: "gpt-4" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions/:id/turns returns 404 for an unknown session", async () => {
    const { app } = makeApp(); // sdk.getSessionInfo undefined -> not found
    const res = await app.request("/sessions/does-not-exist/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "again" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /sessions/:id/turns resumes a known session", async () => {
    const { app, registry } = makeApp();
    // 先建会话
    await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(registry.has("sess-1")).toBe(true);
    const res = await app.request("/sessions/sess-1/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "again" }),
    });
    expect(res.status).toBe(200);
    const { events } = await collectSse(res);
    expect(events).toContain("result");
    expect(registry.get("sess-1")?.turns).toBe(2);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test routes-sse`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 routes/sessions.ts（SSE 部分 + 类型）**

```ts
import { randomUUID } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RuntimeConfig } from "../agent/config.js";
import { isModelAllowed } from "../agent/config.js";
import { type QueryFn, runTurn } from "../agent/runtime.js";
import { extractChangedFiles, type SessionRegistry } from "../agent/session-store.js";
import { CreateSessionBody, SseEventSchema } from "../schemas/index.js";

// 注入式 SDK 句柄（测试传假实现；生产由 server.ts 默认接真 SDK）。
export interface SessionSdk {
  getSessionInfo?: (
    id: string,
    opts: { dir: string },
  ) => Promise<{ sessionId: string; summary: string; cwd?: string; gitBranch?: string } | undefined>;
  getSessionMessages?: (
    id: string,
    opts: { dir: string },
  ) => Promise<
    Array<{
      type: "user" | "assistant" | "system";
      uuid: string;
      session_id: string;
      message: unknown;
      parent_tool_use_id: string | null;
    }>
  >;
  deleteSession?: (id: string, opts: { dir: string }) => Promise<void>;
}

export interface SessionRouteDeps {
  config: RuntimeConfig;
  registry: SessionRegistry;
  queryFn?: QueryFn;
  sdk: SessionSdk;
  version: string;
}

function readBody(c: Context): Promise<{ prompt?: unknown; model?: unknown }> {
  return c.req.json().catch(() => ({}));
}

// 共享一轮流式执行：建 AbortController、跑 runTurn、把事件映射成 SSE 并维护 registry。
function streamTurn(
  c: Context,
  input: { prompt: string; model?: string; resumeId?: string },
  deps: SessionRouteDeps,
): Response {
  const abortController = new AbortController();
  return streamSSE(c, async (stream) => {
    let sid = input.resumeId;
    try {
      for await (const evt of runTurn({ ...input, abortController }, deps.config, deps.queryFn)) {
        if (stream.aborted) break;
        if (evt.event === "init") {
          sid = String(evt.data.sessionId);
          deps.registry.startTurn(sid, {
            model: input.model ?? deps.config.defaultModel,
            abortController,
          });
        } else if (evt.event === "assistant" && sid) {
          const toolUses = (evt.data.toolUses ?? []) as Array<{ name: string; input: unknown }>;
          deps.registry.trackChangedFiles(sid, extractChangedFiles(toolUses));
        } else if (evt.event === "result" && sid) {
          const d = evt.data as {
            usage?: { input_tokens?: number; output_tokens?: number };
            total_cost_usd?: number;
          };
          deps.registry.recordResult(sid, {
            inputTokens: d.usage?.input_tokens ?? 0,
            outputTokens: d.usage?.output_tokens ?? 0,
            costUsd: d.total_cost_usd ?? 0,
          });
        }
        await stream.writeSSE({
          event: evt.event,
          data: JSON.stringify(evt.data),
          ...(evt.id ? { id: evt.id } : {}),
        });
      }
      if (sid) deps.registry.finishTurn(sid, "idle");
    } catch (err) {
      if (abortController.signal.aborted) {
        if (sid) deps.registry.finishTurn(sid, "aborted");
        await stream.writeSSE({ event: "aborted", data: JSON.stringify({ sessionId: sid ?? null }) });
        return;
      }
      const correlationId = randomUUID();
      console.error(`[sessions] error correlationId=${correlationId}:`, err);
      if (sid) deps.registry.finishTurn(sid, "error");
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: "internal error", correlationId }),
      });
    }
  });
}

export function registerSessionRoutes(app: OpenAPIHono, deps: SessionRouteDeps): void {
  const { config } = deps;

  // ---- OpenAPI 登记（SSE 端点用 registerPath 手动登记单事件载荷）----
  for (const path of ["/sessions", "/sessions/{id}/turns"]) {
    app.openAPIRegistry.registerPath({
      method: "post",
      path,
      summary: path === "/sessions" ? "创建会话并执行首轮（SSE）" : "追加一轮（resume，SSE）",
      tags: ["sessions"],
      request: {
        body: { content: { "application/json": { schema: CreateSessionBody } } },
      },
      responses: {
        200: {
          description: "text/event-stream：本轮事件（单事件载荷见 schema）",
          content: { "text/event-stream": { schema: SseEventSchema } },
        },
        400: { description: "prompt 缺失或 model 不在白名单" },
        404: { description: "会话不存在（仅 turns）" },
      },
    });
  }

  // ---- POST /sessions：首轮 ----
  app.post("/sessions", async (c) => {
    const body = await readBody(c);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt) return c.json({ error: "prompt is required" }, 400);
    const model = typeof body.model === "string" ? body.model : undefined;
    if (!isModelAllowed(model, config.allowedModels)) {
      return c.json({ error: `model not allowed: ${model}` }, 400);
    }
    return streamTurn(c, { prompt, model }, deps);
  });

  // ---- POST /sessions/:id/turns：续写 ----
  app.post("/sessions/:id/turns", async (c) => {
    const id = c.req.param("id");
    if (!deps.registry.has(id)) {
      const info = deps.sdk.getSessionInfo
        ? await deps.sdk.getSessionInfo(id, { dir: config.cwd })
        : undefined;
      if (!info) return c.json({ error: "session not found" }, 404);
    }
    const body = await readBody(c);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt) return c.json({ error: "prompt is required" }, 400);
    const model = typeof body.model === "string" ? body.model : undefined;
    if (!isModelAllowed(model, config.allowedModels)) {
      return c.json({ error: `model not allowed: ${model}` }, 400);
    }
    return streamTurn(c, { prompt, model, resumeId: id }, deps);
  });
}
```

> **注意**：上面 import 自 `../schemas/index.js`。请在 Step 5 创建该 barrel 文件，避免散乱 import。

- [ ] **Step 5: 创建 schemas barrel `apps/runtime/src/schemas/index.ts`**

```ts
export * from "./events.js";
export * from "./sessions.js";
```

- [ ] **Step 6: 运行确认通过 + 检查**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test routes-sse && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: PASS；typecheck exit 0；biome exit 0。
> 若 `registerPath` 的 `request.params: undefined` 触发类型问题，直接删除该条件分支（两个路径用同一 body schema 即可；路径参数对 SSE 文档非必需）。

- [ ] **Step 7: 提交**

```bash
git add apps/runtime/src/routes/sessions.ts apps/runtime/src/schemas/index.ts apps/runtime/test/routes-sse.test.ts apps/runtime/test/helpers.ts
git commit -m "feat(runtime): SSE 对话端点（首轮 + resume）+ registry 接线 + 白名单/404"
```

---

## Task 6: routes/sessions.ts — REST 端点（list/info/transcript/stop/delete）

**Files:**
- Modify: `apps/runtime/src/routes/sessions.ts`
- Create: `apps/runtime/test/routes-rest.test.ts`

- [ ] **Step 1: 写失败测试 routes-rest.test.ts**

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/agent/session-store.js";
import { registerSessionRoutes, type SessionSdk } from "../src/routes/sessions.js";
import { fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

function makeApp(sdk: SessionSdk = {}) {
  const app = new OpenAPIHono();
  const registry = new SessionRegistry();
  registerSessionRoutes(app, {
    config: testConfig,
    queryFn: fakeQueryFn(sampleMessages),
    registry,
    sdk,
    version: "test",
  });
  return { app, registry };
}

describe("REST routes", () => {
  it("GET /sessions lists registry records", async () => {
    const { app, registry } = makeApp();
    registry.startTurn("s1", { model: "m", abortController: new AbortController() });
    registry.finishTurn("s1", "idle");
    const res = await app.request("/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; turns: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("s1");
  });

  it("GET /sessions/:id merges registry + disk info; 404 when neither", async () => {
    const sdk: SessionSdk = {
      getSessionInfo: async (id) =>
        id === "disk-only"
          ? { sessionId: id, summary: "from disk", cwd: "/workspace" }
          : undefined,
    };
    const { app, registry } = makeApp(sdk);
    registry.startTurn("s1", { model: "m", abortController: new AbortController() });
    const r1 = await app.request("/sessions/s1");
    expect(r1.status).toBe(200);
    const r2 = await app.request("/sessions/disk-only");
    expect(r2.status).toBe(200);
    expect((await r2.json() as { summary?: string }).summary).toBe("from disk");
    const r3 = await app.request("/sessions/nope");
    expect(r3.status).toBe(404);
  });

  it("GET /sessions/:id/transcript returns getSessionMessages output", async () => {
    const sdk: SessionSdk = {
      getSessionMessages: async () => [
        { type: "user", uuid: "u1", session_id: "s1", message: { role: "user" }, parent_tool_use_id: null },
      ],
    };
    const { app } = makeApp(sdk);
    const res = await app.request("/sessions/s1/transcript");
    expect(res.status).toBe(200);
    expect((await res.json() as unknown[]).length).toBe(1);
  });

  it("POST /sessions/:id/stop aborts an active turn", async () => {
    const { app, registry } = makeApp();
    const ac = new AbortController();
    registry.startTurn("s1", { model: "m", abortController: ac });
    const res = await app.request("/sessions/s1/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json() as { stopped: boolean }).stopped).toBe(true);
    expect(ac.signal.aborted).toBe(true);
  });

  it("DELETE /sessions/:id removes from registry and calls deleteSession", async () => {
    let deleted = "";
    const sdk: SessionSdk = { deleteSession: async (id) => { deleted = id; } };
    const { app, registry } = makeApp(sdk);
    registry.startTurn("s1", { model: "m", abortController: new AbortController() });
    const res = await app.request("/sessions/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json() as { deleted: boolean }).deleted).toBe(true);
    expect(registry.has("s1")).toBe(false);
    expect(deleted).toBe("s1");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test routes-rest`
Expected: FAIL（REST 端点未实现）。

- [ ] **Step 3: 实现 —— 在 routes/sessions.ts 顶部补 import**

把 Task 5 中 `routes/sessions.ts` 顶部的 import 扩展为：

```ts
import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RuntimeConfig } from "../agent/config.js";
import { isModelAllowed } from "../agent/config.js";
import { type QueryFn, runTurn } from "../agent/runtime.js";
import { extractChangedFiles, type SessionRecord, type SessionRegistry } from "../agent/session-store.js";
import {
  CreateSessionBody,
  DeleteResponse,
  ErrorResponse,
  SessionIdParam,
  SessionInfo,
  SessionListItem,
  SseEventSchema,
  StopResponse,
  TranscriptMessage,
} from "../schemas/index.js";
```

- [ ] **Step 4: 实现 —— 在 registerSessionRoutes 末尾追加 REST 路由**

在 `registerSessionRoutes` 函数体（Task 5 的两个 SSE 端点之后）追加：

```ts
  // 把 registry 记录投影成 list item（model 用 null 兼容 schema 的 nullable）。
  const toListItem = (r: SessionRecord) => ({
    id: r.id,
    model: r.model ?? null,
    status: r.status,
    turns: r.turns,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    totalCostUsd: r.totalCostUsd,
    changedFiles: r.changedFiles,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
  });

  // GET /sessions
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions",
      tags: ["sessions"],
      summary: "列出会话（运行态视图）",
      responses: {
        200: {
          description: "会话列表",
          content: { "application/json": { schema: SessionListItem.array() } },
        },
      },
    }),
    (c) => c.json(deps.registry.list().map(toListItem), 200),
  );

  // GET /sessions/:id
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}",
      tags: ["sessions"],
      summary: "会话信息（registry + 盘上 getSessionInfo）",
      request: { params: SessionIdParam },
      responses: {
        200: { description: "会话信息", content: { "application/json": { schema: SessionInfo } } },
        404: { description: "未找到", content: { "application/json": { schema: ErrorResponse } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const rec = deps.registry.get(id);
      const info = deps.sdk.getSessionInfo
        ? await deps.sdk.getSessionInfo(id, { dir: config.cwd })
        : undefined;
      if (!rec && !info) return c.json({ error: "session not found" }, 404);
      const base = rec
        ? toListItem(rec)
        : {
            id,
            model: null,
            status: "idle" as const,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0,
            changedFiles: [],
            createdAt: 0,
            lastActiveAt: 0,
          };
      return c.json(
        {
          ...base,
          ...(info
            ? { summary: info.summary, cwd: info.cwd, gitBranch: info.gitBranch }
            : {}),
        },
        200,
      );
    },
  );

  // GET /sessions/:id/transcript
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}/transcript",
      tags: ["sessions"],
      summary: "完整 transcript（getSessionMessages）",
      request: { params: SessionIdParam },
      responses: {
        200: {
          description: "消息列表",
          content: { "application/json": { schema: TranscriptMessage.array() } },
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const msgs = deps.sdk.getSessionMessages
        ? await deps.sdk.getSessionMessages(id, { dir: config.cwd })
        : [];
      return c.json(msgs, 200);
    },
  );

  // POST /sessions/:id/stop
  app.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/stop",
      tags: ["sessions"],
      summary: "中止当前轮（abortController.abort()）",
      request: { params: SessionIdParam },
      responses: {
        200: { description: "是否成功中止", content: { "application/json": { schema: StopResponse } } },
      },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      return c.json({ stopped: deps.registry.abort(id) }, 200);
    },
  );

  // DELETE /sessions/:id
  app.openapi(
    createRoute({
      method: "delete",
      path: "/sessions/{id}",
      tags: ["sessions"],
      summary: "删除会话（盘上 deleteSession + 清 registry）",
      request: { params: SessionIdParam },
      responses: {
        200: { description: "已删除", content: { "application/json": { schema: DeleteResponse } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      deps.registry.abort(id);
      if (deps.sdk.deleteSession) {
        try {
          await deps.sdk.deleteSession(id, { dir: config.cwd });
        } catch (err) {
          console.error("[sessions] deleteSession failed:", err);
        }
      }
      deps.registry.remove(id);
      return c.json({ deleted: true }, 200);
    },
  );
```

- [ ] **Step 5: 运行确认通过 + 检查**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test routes-rest && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: PASS；typecheck exit 0；biome exit 0。
> `c.req.valid("param")` 需要 route 定义了 `request.params`；本任务每个带 `{id}` 的 route 都定义了 `SessionIdParam`，类型可推。

- [ ] **Step 6: 提交**

```bash
git add apps/runtime/src/routes/sessions.ts apps/runtime/test/routes-rest.test.ts
git commit -m "feat(runtime): REST 会话端点 list/info/transcript/stop/delete（注入式 SDK）"
```

---

## Task 7: server.ts → OpenAPIHono 装配（CORS / healthz / config / doc31 / swaggerUI）

**Files:**
- Modify: `apps/runtime/src/server.ts`
- Modify: `apps/runtime/src/index.ts`
- Modify: `apps/runtime/test/server.test.ts`

- [ ] **Step 1: 重写 server.test.ts**

```ts
import { describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../src/agent/session-store.js";
import type { QueryFn } from "../src/agent/runtime.js";
import { createServer } from "../src/server.js";
import { collectSse, fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

describe("createServer", () => {
  it("GET /healthz returns ok", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /config includes allowlist and playground fields", async () => {
    const app = createServer({
      config: { ...testConfig, allowedModels: ["MiniMax-M3"] },
      queryFn: fakeQueryFn([]),
      sdk: {},
      version: "1.2.3",
    });
    const res = await app.request("/config");
    expect(await res.json()).toEqual({
      defaultModel: "MiniMax-M3",
      allowedModels: ["MiniMax-M3"],
      jaegerBaseUrl: null,
      version: "1.2.3",
      includePartial: false,
    });
  });

  it("GET /openapi.json is an OpenAPI 3.1 document covering /sessions", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/sessions", "/sessions/{id}", "/sessions/{id}/transcript"]),
    );
  });

  it("GET /docs serves Swagger UI html", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("swagger");
  });

  it("CORS preflight is allowed", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/config", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "GET" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("POST /sessions streams mapped SSE events end-to-end", async () => {
    const registry = new SessionRegistry();
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn(sampleMessages), sdk: {}, registry });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events } = await collectSse(res);
    expect(events).toEqual(["init", "assistant", "tool_result", "result"]);
    expect(registry.get("sess-1")?.turns).toBe(1);
  });

  it("maps a runtime error to a generic SSE error (no internal detail leaked)", async () => {
    const throwing: QueryFn = () => {
      throw new Error("boom secret internal detail");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createServer({ config: testConfig, queryFn: throwing, sdk: {} });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    const text = await res.text();
    errSpy.mockRestore();
    expect(text).toContain("event: error");
    expect(text).toContain("internal error");
    expect(text).toContain("correlationId");
    expect(text).not.toContain("boom secret internal detail");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test server`
Expected: FAIL（createServer 仍是旧 Hono，无 openapi.json/docs/cors/allowedModels；`sdk` 不在 ServerDeps）。

- [ ] **Step 3: 重写 server.ts**

```ts
import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { RuntimeConfig } from "./agent/config.js";
import type { QueryFn } from "./agent/runtime.js";
import { SessionRegistry } from "./agent/session-store.js";
import { registerSessionRoutes, type SessionSdk } from "./routes/sessions.js";

export interface ServerDeps {
  config: RuntimeConfig;
  queryFn?: QueryFn;
  registry?: SessionRegistry;
  sdk?: SessionSdk;
  version?: string;
}

export function createServer(deps: ServerDeps): OpenAPIHono {
  const { config, version = "0.0.0" } = deps;
  const registry = deps.registry ?? new SessionRegistry();
  const sdk: SessionSdk = deps.sdk ?? { getSessionInfo, getSessionMessages, deleteSession };

  const app = new OpenAPIHono();

  app.use(
    "*",
    cors({
      origin:
        config.corsOrigins === "*"
          ? "*"
          : config.corsOrigins.split(",").map((s) => s.trim()),
    }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/config", (c) =>
    c.json({
      defaultModel: config.defaultModel ?? null,
      allowedModels: config.allowedModels ?? null,
      jaegerBaseUrl: config.jaegerBaseUrl ?? null,
      version,
      includePartial: config.includePartial,
    }),
  );

  registerSessionRoutes(app, { config, queryFn: deps.queryFn, registry, sdk, version });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Coding Agent Runtime", version },
  });
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  return app;
}
```

> `app.doc31(path, doc)` 在 @hono/zod-openapi 1.x 存在（生成 OpenAPI 3.1）。若该版本方法名有变，回退用 `app.doc(path, { openapi: "3.1.0", ... })`（1.x 的 `doc` 接受并透传 `openapi` 版本字段），仍满足 `/^3\.1/` 断言。

- [ ] **Step 4: 同步 index.ts（createServer 返回类型变了，但调用不变）**

`apps/runtime/src/index.ts` 的 `serve({ fetch: app.fetch, ... })` 仍可用（OpenAPIHono 有 `.fetch`）。无需改动；若 typecheck 报 `app.fetch` 类型，确认 import 的是同一 createServer 即可。保持文件原样。

- [ ] **Step 5: 运行确认通过 + 全量检查**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: 全部测试通过；typecheck exit 0；biome exit 0。

- [ ] **Step 6: 提交**

```bash
git add apps/runtime/src/server.ts apps/runtime/src/index.ts apps/runtime/test/server.test.ts
git commit -m "feat(runtime): server 升级为 OpenAPIHono（CORS + healthz/config + 挂会话路由 + doc31 + Swagger UI）"
```

---

## Task 8: apps/web 脚手架（Vite + React + TS，可 build）

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Modify: `package.json`（root，加 dev:web）
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 创建 apps/web/package.json**

```json
{
  "name": "@app/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.2.0",
    "typescript": "^5.9.3",
    "vite": "^7.3.5",
    "vitest": "^3.2.6"
  }
}
```

- [ ] **Step 2: 创建配置文件**

`apps/web/vite.config.ts`：

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
```

`apps/web/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

`apps/web/tsconfig.json`（覆盖 base 的 NodeNext，用 Bundler 解析 + DOM lib + react-jsx）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 index.html + 入口**

`apps/web/index.html`：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Coding Agent Runtime — Playground</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/main.tsx`（注意：Bundler 解析，import **不带**扩展名）：

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
```

`apps/web/src/App.tsx`（脚手架占位，Task 10 替换为真实 UI）：

```tsx
export function App() {
  return (
    <main className="app">
      <h1>Coding Agent Runtime — Playground</h1>
      <p>scaffold ok</p>
    </main>
  );
}
```

`apps/web/src/styles.css`：

```css
:root {
  font-family: ui-sans-serif, system-ui, sans-serif;
  color-scheme: light dark;
}
body {
  margin: 0;
}
.app {
  max-width: 960px;
  margin: 0 auto;
  padding: 1rem;
}
```

- [ ] **Step 4: root package.json 加 dev:web 脚本**

在根 `package.json` 的 `"scripts"` 加一行：

```json
    "dev:web": "pnpm --filter @app/web dev",
```

- [ ] **Step 5: 安装 + 更新锁文件**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 install`
Expected: 成功；`@app/web` 进 workspace；lockfile 更新。`@vitejs/plugin-react` 可能对可选 peer（babel-plugin-react-compiler 等）有 WARN，可忽略。

- [ ] **Step 6: build + typecheck + biome 验证**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web build && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: vite build 产出 `apps/web/dist`；biome exit 0。
> 若 biome 对 tsx 报 a11y/规则，按提示最小修正（保持 recommended）。若根 `pnpm build`（`-r`）因 web 触发问题，确认 web 的 build 脚本为 `tsc --noEmit && vite build`。

- [ ] **Step 7: 提交**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat(web): apps/web 脚手架（Vite+React+TS，可 build）"
```

---

## Task 9: web SSE 解析 + HTTP 客户端（纯逻辑，TDD）

**Files:**
- Create: `apps/web/src/lib/sse.ts`
- Create: `apps/web/src/lib/sse.test.ts`
- Create: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 写失败测试 sse.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { parseSseBlock, readSse } from "./sse";

describe("parseSseBlock", () => {
  it("parses event + data + id", () => {
    expect(parseSseBlock("event: init\ndata: {\"sessionId\":\"s1\"}\nid: u1")).toEqual({
      event: "init",
      data: '{"sessionId":"s1"}',
      id: "u1",
    });
  });
  it("joins multi-line data and defaults event to message", () => {
    expect(parseSseBlock("data: a\ndata: b")).toEqual({ event: "message", data: "a\nb" });
  });
  it("returns null for comment/keepalive-only blocks", () => {
    expect(parseSseBlock(": keepalive")).toBeNull();
  });
});

describe("readSse", () => {
  it("yields events split on blank lines across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const chunks = ["event: init\ndata: 1\n\nev", "ent: result\ndata: 2\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const out: Array<{ event: string; data: string }> = [];
    for await (const e of readSse(stream)) out.push({ event: e.event, data: e.data });
    expect(out).toEqual([
      { event: "init", data: "1" },
      { event: "result", data: "2" },
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web test`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 sse.ts**

```ts
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (dataLines.length === 0) return null;
  return id === undefined ? { event, data: dataLines.join("\n") } : { event, data: dataLines.join("\n"), id };
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseSseBlock(block);
      if (evt) yield evt;
      idx = buf.indexOf("\n\n");
    }
  }
}
```

- [ ] **Step 4: 实现 api.ts**

```ts
import { readSse, type SseEvent } from "./sse";

export interface RuntimeConfigDto {
  defaultModel: string | null;
  allowedModels: string[] | null;
  jaegerBaseUrl: string | null;
  version: string;
  includePartial: boolean;
}

export async function getHealth(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function getConfig(base: string): Promise<RuntimeConfigDto> {
  const res = await fetch(`${base}/config`);
  if (!res.ok) throw new Error(`config failed: ${res.status}`);
  return (await res.json()) as RuntimeConfigDto;
}

export async function* streamTurn(
  base: string,
  opts: { sessionId?: string; prompt: string; model?: string },
): AsyncGenerator<SseEvent> {
  const url = opts.sessionId ? `${base}/sessions/${opts.sessionId}/turns` : `${base}/sessions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: opts.prompt, model: opts.model }),
  });
  if (!res.ok || !res.body) throw new Error(`turn failed: ${res.status}`);
  yield* readSse(res.body);
}

export async function stopSession(base: string, id: string): Promise<void> {
  await fetch(`${base}/sessions/${id}/stop`, { method: "POST" });
}
```

- [ ] **Step 5: 运行确认通过 + 检查**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web test && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web typecheck && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: PASS；typecheck exit 0；biome exit 0。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib
git commit -m "feat(web): SSE 解析（纯函数，含跨 chunk）+ runtime HTTP 客户端"
```

---

## Task 10: web UI（连接 + 多轮对话 + 看 spec）

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/components/ConnectionBar.tsx`
- Create: `apps/web/src/components/ChatPanel.tsx`
- Create: `apps/web/src/components/SpecPanel.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: ConnectionBar.tsx**

```tsx
import { useState } from "react";
import { getConfig, getHealth, type RuntimeConfigDto } from "../lib/api";

interface Props {
  baseUrl: string;
  // 成功时上抛最终编辑后的 baseUrl + config（App.tsx 据此记下当前 baseUrl）。
  onConnected: (baseUrl: string, cfg: RuntimeConfigDto) => void;
}

export function ConnectionBar({ baseUrl: initial, onConnected }: Props) {
  const [baseUrl, setBaseUrl] = useState(initial);
  const [status, setStatus] = useState<"idle" | "connecting" | "ok" | "fail">("idle");

  async function connect() {
    setStatus("connecting");
    const healthy = await getHealth(baseUrl);
    if (!healthy) {
      setStatus("fail");
      return;
    }
    try {
      const cfg = await getConfig(baseUrl);
      setStatus("ok");
      onConnected(baseUrl, cfg);
    } catch {
      setStatus("fail");
    }
  }

  return (
    <div className="connbar">
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="http://localhost:8080"
        aria-label="runtime base url"
      />
      <button type="button" onClick={connect}>
        连接
      </button>
      <span className={`status status-${status}`}>{status}</span>
    </div>
  );
}
```

- [ ] **Step 2: ChatPanel.tsx**

```tsx
import { useState } from "react";
import { stopSession, streamTurn } from "../lib/api";

interface Line {
  kind: "user" | "assistant" | "tool" | "result" | "error" | "system";
  text: string;
}

interface Props {
  baseUrl: string;
  model: string | undefined;
}

export function ChatPanel({ baseUrl, model }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  function push(line: Line) {
    setLines((prev) => [...prev, line]);
  }

  async function send() {
    if (!prompt.trim() || busy) return;
    const text = prompt;
    setPrompt("");
    push({ kind: "user", text });
    setBusy(true);
    try {
      for await (const evt of streamTurn(baseUrl, { sessionId, prompt: text, model })) {
        const data = JSON.parse(evt.data) as Record<string, unknown>;
        if (evt.event === "init") {
          setSessionId(String(data.sessionId));
          push({ kind: "system", text: `session ${data.sessionId} · model ${data.model ?? ""}` });
        } else if (evt.event === "assistant") {
          if (data.text) push({ kind: "assistant", text: String(data.text) });
          const toolUses = (data.toolUses ?? []) as Array<{ name: string; input: unknown }>;
          for (const t of toolUses) push({ kind: "tool", text: `→ ${t.name} ${JSON.stringify(t.input)}` });
        } else if (evt.event === "tool_result") {
          push({ kind: "tool", text: `✓ tool_result` });
        } else if (evt.event === "result") {
          const u = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          push({
            kind: "result",
            text: `done · turns ${data.num_turns} · in ${u?.input_tokens ?? 0} out ${u?.output_tokens ?? 0} · $${data.total_cost_usd ?? 0}`,
          });
        } else if (evt.event === "error" || evt.event === "aborted") {
          push({ kind: "error", text: `${evt.event}: ${evt.data}` });
        }
      }
    } catch (err) {
      push({ kind: "error", text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {lines.map((l, i) => (
          <div key={i} className={`line line-${l.kind}`}>
            {l.text}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="给 agent 的指令…"
          aria-label="prompt"
        />
        <div className="chat-actions">
          <button type="button" onClick={send} disabled={busy}>
            {sessionId ? "续轮发送" : "发送"}
          </button>
          <button
            type="button"
            onClick={() => sessionId && stopSession(baseUrl, sessionId)}
            disabled={!busy || !sessionId}
          >
            停止
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionId(undefined);
              setLines([]);
            }}
            disabled={busy}
          >
            新建会话
          </button>
          <span className="sid">{sessionId ? `会话 ${sessionId}` : "未开始"}</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: SpecPanel.tsx**

```tsx
interface Props {
  baseUrl: string;
}

export function SpecPanel({ baseUrl }: Props) {
  return (
    <div className="spec">
      <p>
        <a href={`${baseUrl}/docs`} target="_blank" rel="noreferrer">
          在新标签打开 Swagger UI
        </a>
        {" · "}
        <a href={`${baseUrl}/openapi.json`} target="_blank" rel="noreferrer">
          openapi.json
        </a>
      </p>
      <iframe className="spec-frame" title="OpenAPI docs" src={`${baseUrl}/docs`} />
    </div>
  );
}
```

- [ ] **Step 4: App.tsx 接线**

```tsx
import { useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { ConnectionBar } from "./components/ConnectionBar";
import { SpecPanel } from "./components/SpecPanel";
import type { RuntimeConfigDto } from "./lib/api";

export function App() {
  const [baseUrl, setBaseUrl] = useState("http://localhost:8080");
  const [cfg, setCfg] = useState<RuntimeConfigDto | null>(null);
  const [tab, setTab] = useState<"chat" | "spec">("chat");
  const [model, setModel] = useState<string | undefined>(undefined);

  return (
    <main className="app">
      <h1>Coding Agent Runtime — Playground</h1>
      <ConnectionBar
        baseUrl={baseUrl}
        onConnected={(url, c) => {
          setBaseUrl(url);
          setCfg(c);
          setModel(c.defaultModel ?? undefined);
        }}
      />
      {cfg && (
        <>
          <div className="toolbar">
            <button type="button" onClick={() => setTab("chat")} disabled={tab === "chat"}>
              对话
            </button>
            <button type="button" onClick={() => setTab("spec")} disabled={tab === "spec"}>
              spec
            </button>
            {cfg.allowedModels && cfg.allowedModels.length > 0 ? (
              <select value={model ?? ""} onChange={(e) => setModel(e.target.value || undefined)}>
                {cfg.allowedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={model ?? ""}
                onChange={(e) => setModel(e.target.value || undefined)}
                placeholder={cfg.defaultModel ?? "model"}
                aria-label="model"
              />
            )}
            <span className="ver">runtime v{cfg.version}</span>
          </div>
          {tab === "chat" ? <ChatPanel baseUrl={baseUrl} model={model} /> : <SpecPanel baseUrl={baseUrl} />}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 5: 在 styles.css 追加布局样式**

```css
.connbar,
.toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin: 0.75rem 0;
  flex-wrap: wrap;
}
.connbar input {
  flex: 1;
  min-width: 16rem;
}
.status-ok {
  color: green;
}
.status-fail {
  color: crimson;
}
.chat-log {
  border: 1px solid #8884;
  border-radius: 6px;
  padding: 0.5rem;
  min-height: 16rem;
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
}
.line {
  padding: 0.15rem 0;
}
.line-user {
  font-weight: 600;
}
.line-tool {
  color: #2a7;
}
.line-error {
  color: crimson;
}
.line-result {
  color: #69f;
}
.chat-input textarea {
  width: 100%;
  min-height: 4rem;
  margin-top: 0.5rem;
}
.chat-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.5rem;
}
.spec-frame {
  width: 100%;
  height: 70vh;
  border: 1px solid #8884;
  border-radius: 6px;
}
```

- [ ] **Step 6: build + typecheck + biome**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web build && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/web test && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: vite build 成功；sse 测试通过；biome exit 0。
> biome 可能对 `key={i}`（noArrayIndexKey）告警 —— 它是 lint **warn** 非 error，不阻断；若被当作 error，给该行加 `// biome-ignore lint/suspicious/noArrayIndexKey: 对话日志仅追加` 或改用稳定 key。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src
git commit -m "feat(web): 连接栏 + 多轮对话（SSE 渲染/停止/新建）+ spec 内嵌"
```

---

## Task 11: 文档 + .env.example + 真实 MiniMax 多轮验收

**Files:**
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-06-03-coding-agent-runtime-design.md`（状态/开放问题 #6 标注）
- 验收：docker 真实多轮 + web 连通

- [ ] **Step 1: .env.example 增补**

在 `.env.example` 末尾加：

```
# P1：可选 model 白名单（逗号分隔；留空=不限制）。显式请求不在白名单的 model 会被 400 拒绝。
RUNTIME_ALLOWED_MODELS=
# P1：CORS 允许的前端 origin（可信网络可 *；多个用逗号分隔）。
CORS_ORIGINS=*
```

- [ ] **Step 2: design spec 标注 P1 已落地 + 解决开放问题 #6**

在 `docs/superpowers/specs/2026-06-03-coding-agent-runtime-design.md` 的 §13 开放问题 #6 行后追加一句：「（P1 决策：界面用 iframe 内嵌 runtime 的 `/docs` + 直链，不引入 Scalar；后续如需再评估）」；并在文档顶部状态区或 §12 P1 行补注「P1 已实现」。保持改动最小，不重写。

- [ ] **Step 3: 全量构建与检查（合并前门槛）**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 -r run test && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 -r run build && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`
Expected: runtime + web 测试全过；两包 build 成功；biome exit 0。

- [ ] **Step 4: docker 真实多轮验收**

```bash
docker build -f apps/runtime/Dockerfile -t coding-agent-runtime:p1 .
docker run -d --name car-p1 --env-file .env \
  -e ANTHROPIC_SMALL_FAST_MODEL=MiniMax-M3 -e ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M3 \
  -p 127.0.0.1:8080:8080 -v car-p1-ws:/workspace -v car-p1-cfg:/claude-config \
  coding-agent-runtime:p1
```

验收脚本（逐条 curl）：
1. `GET /openapi.json` → `openapi` 字段以 `3.1` 开头；paths 含 `/sessions`、`/sessions/{id}`、`/sessions/{id}/transcript`、`/sessions/{id}/stop`。
2. 首轮 `POST /sessions`，prompt：`记住这个数字：42。只回复"好的"。` → 从 `init` 事件拿 `sessionId`；`result` 事件 `is_error:false`。
3. 续轮 `POST /sessions/{sessionId}/turns`，prompt：`我刚才让你记住的数字是多少？` → assistant 文本应包含 `42`（**多轮上下文连续**，核心验收）。
4. `GET /sessions` → 含该 sessionId，`turns>=2`，`status` 为 `idle`。
5. `GET /sessions/{sessionId}/transcript` → 返回非空消息数组。
6. `DELETE /sessions/{sessionId}` → `{deleted:true}`；随后 `GET /sessions` 不再含它。

Expected：第 3 步出现 `42` = 多轮 resume 成功。失败则排查 `CLAUDE_CONFIG_DIR`/`cwd` 恒定与 resume 透传。
> 清理：`docker rm -f car-p1`（卷按需保留/删除）。

- [ ] **Step 5: web 连通验收（本机）**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 dev:web`
打开 `http://localhost:5173`：输入 `http://localhost:8080` → 连接显示 ok；切 spec 标签能看到内嵌 Swagger UI；对话标签发一轮、再续一轮，能看到 assistant 文本/工具行/最终用量；「停止」「新建会话」可用。
> CORS：runtime 默认 `CORS_ORIGINS=*`，web(5173) 跨域请求应放行。

- [ ] **Step 6: 提交文档改动**

```bash
git add .env.example docs/superpowers/specs/2026-06-03-coding-agent-runtime-design.md
git commit -m "docs(p1): .env.example 增补 RUNTIME_ALLOWED_MODELS/CORS_ORIGINS + spec 标注 P1 落地"
```

---

## 完成标准（P1 验收，对齐 spec §12）

- **多轮上下文连续**：`POST /sessions` 建会话 → `POST /sessions/:id/turns` 续写，agent 记得上一轮信息（docker 验收第 3 步出现 `42`）。
- **MiniMax-M3 完成真实任务**：真实端点下首轮+续轮均 `is_error:false`。
- **`/sessions/*` 全套可用**：list / info / transcript / stop / delete 行为正确（单测 + docker 验收）。
- **OpenAPI 3.1 + Swagger UI + CORS**：`/openapi.json` 为 3.1 且覆盖会话端点；`/docs` 可打开；跨域放行。
- **model 白名单**：配置后显式请求非白名单 model 被 400 拒绝。
- **界面能连容器、看 spec、对话**：web 连接 ok、内嵌 spec 可见、多轮对话可用。
- **质量门槛**：`pnpm -r test` 全过、`pnpm -r build` 成功、`biome check` exit 0、`tsc --noEmit` 两包 exit 0。
- **P0 锁定项未回退**：无鉴权、bypassPermissions、env 整体 spread、disallowedTools 兜底仍在。

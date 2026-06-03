# Coding Agent Runtime — P0 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭出一个能 `docker run` 起来、`POST /sessions` 即用 SSE 流式返回容器内 Claude Code（经 Agent SDK 自带 CLI）单轮编码输出的自包含 runtime 容器骨架。

**Architecture:** pnpm 单仓（`apps/*`）下的 `apps/runtime` 是一个 Hono(Node 22, ESM) HTTP 服务；`runTurn()` 把 `@anthropic-ai/claude-agent-sdk` 的 `query()`（用 SDK 自带 CLI，`bypassPermissions`，`systemPrompt` 用 `claude_code` preset + `settingSources:['user','project']`）产出的 `SDKMessage` 流映射成 SSE 事件；容器镜像内置 `git/gh/node/uv+python3.12`，entrypoint 幂等把固定 guidelines 写进 `$CLAUDE_CONFIG_DIR/CLAUDE.md` 并 `gh auth setup-git`，最后 `exec node dist/index.js`。`query` 通过依赖注入（`queryFn`）实现单测解耦。

**Tech Stack:** Node 22 + TypeScript 5.9（NodeNext ESM）、pnpm 10 workspace、Hono 4.12 + `@hono/node-server` 2、`@anthropic-ai/claude-agent-sdk` 0.3.161、Vitest 3、Biome 2、Docker（`node:22-bookworm-slim`）。

**P0 范围边界（严格对齐 spec §12）：** 只做骨架——monorepo 脚手架、`apps/runtime`（healthz/config + 单轮 `POST /sessions` SSE）、Dockerfile + entrypoint + 固定 guidelines。**明确不在 P0**（后续阶段做，本计划不实现）：多轮 resume / Session Registry / `/sessions/*` 全套（P1）、OpenAPI 文档 + Swagger UI + CORS + `apps/web`（P1）、OTel/telemetry/traceId（P2）、PreToolUse Bash 白名单 + `disallowedTools` + egress（P3）。因此 P0 用**朴素 Hono**（非 `OpenAPIHono`），不引 `zod`/`@hono/zod-openapi`/`@hono/swagger-ui`——这些随 P1 的 OpenAPI 工作一起进来。

---

## File Structure

P0 结束后仓库新增/变更的文件（已存在：`CLAUDE.md`、`.gitignore`、`docs/...`）：

```
coding-agent-runtime/
  pnpm-workspace.yaml              # 新建：packages: apps/*
  package.json                     # 新建：根脚本 + Biome/TS devDeps + packageManager
  tsconfig.base.json               # 新建：NodeNext + strict 共享配置
  biome.json                       # 新建：Biome v2 lint+format
  .nvmrc                           # 新建：22
  .env.example                     # 新建：所有 env 变量样例（不含真实密钥）
  .dockerignore                    # 新建：根级（build 上下文是仓库根，Docker 只读这里）
  apps/
    runtime/
      package.json                 # 新建：@app/runtime 依赖与脚本
      tsconfig.json                # 新建：extends 根 base
      vitest.config.ts             # 新建：node 环境
      Dockerfile                   # 新建：slim + git/gh/uv/py3.12 + pnpm build
      container/
        entrypoint.sh              # 新建：写 CLAUDE.md + gh auth setup-git + exec node
        agent-CLAUDE.md            # 新建：固定 guidelines（= 根 CLAUDE.md 内容）
      src/
        agent/
          config.ts                # 新建：env → RuntimeConfig（校验）
          runtime.ts               # 新建：runTurn() + SDKMessage→SseEvent 映射（可注入 queryFn）
        server.ts                  # 新建：createServer() → Hono（healthz/config/POST /sessions）
        index.ts                   # 新建：入口，loadConfig + serve()
      test/
        helpers.ts                 # 新建：测试夹具（cfg、样例消息、fakeQueryFn）
        config.test.ts             # 新建
        runtime.test.ts            # 新建
        server.test.ts             # 新建
```

**职责边界：** `config.ts` 只读环境；`runtime.ts` 只做「驱动 query + 映射事件」纯逻辑（不碰 HTTP）；`server.ts` 只做路由装配（不碰进程启动）；`index.ts` 只做启动接线。这样 `runTurn` 和路由都能用注入的假 `queryFn` 离线单测，不需要真实 API Key。

---

## Task 1: Monorepo 根脚手架

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `.nvmrc`

- [ ] **Step 1: 写 `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
```

- [ ] **Step 2: 写根 `package.json`**

```json
{
  "name": "coding-agent-runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.34.1",
  "engines": {
    "node": ">=22 <23"
  },
  "scripts": {
    "dev": "pnpm --filter @app/runtime dev",
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "lint": "biome lint .",
    "format": "biome format --write .",
    "check": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.16",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 3: 写 `tsconfig.base.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "moduleDetection": "force",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: 写 `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.16/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignoreUnknown": false,
    "includes": ["**", "!**/dist", "!**/node_modules", "!**/.tsbuildinfo"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "assist": {
    "enabled": true,
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  }
}
```

- [ ] **Step 5: 写 `.nvmrc`**

```
22
```

- [ ] **Step 6: 安装并验证根工具链**

确保用 corepack 锁定 pnpm 版本（首次需 `corepack enable`）。

Run: `corepack enable; pnpm install`
Expected: 安装成功，生成 `pnpm-lock.yaml`、`node_modules/`（仅根 devDeps：biome + typescript）。无报错。

- [ ] **Step 7: 验证 Biome 可运行**

Run: `pnpm exec biome check .`
Expected: 退出码 0（或仅对已有 md/json 的格式提示——若有，跑 `pnpm run check` 自动修复后再次 `biome check .` 应为 0）。

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json biome.json .nvmrc pnpm-lock.yaml
git commit -m "chore: 初始化 pnpm workspace + Biome/TS 根脚手架"
```

---

## Task 2: `apps/runtime` 包骨架 + 冒烟测试

**Files:**
- Create: `apps/runtime/package.json`
- Create: `apps/runtime/tsconfig.json`
- Create: `apps/runtime/vitest.config.ts`
- Test: `apps/runtime/test/smoke.test.ts`（本任务临时冒烟，Task 3 起被真实测试取代后删除）

- [ ] **Step 1: 写 `apps/runtime/package.json`**

```json
{
  "name": "@app/runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.161",
    "@hono/node-server": "2.0.4",
    "hono": "4.12.23"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "4.22.4",
    "typescript": "^5.9.3",
    "vitest": "^3.2.6"
  }
}
```

- [ ] **Step 2: 写 `apps/runtime/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test", "**/*.test.ts"]
}
```

- [ ] **Step 3: 写 `apps/runtime/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

> 注：不开 `globals`；测试里显式 `import { describe, it, expect } from "vitest"`，省去给 tsconfig 加 `vitest/globals` 类型。

- [ ] **Step 4: 写临时冒烟测试 `apps/runtime/test/smoke.test.ts`**

```ts
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: 安装 runtime 依赖**

Run: `pnpm install`
Expected: 拉入 `apps/runtime` 的依赖（hono、@hono/node-server、@anthropic-ai/claude-agent-sdk 及其自带 CLI + peer deps），更新 `pnpm-lock.yaml`，无报错。

- [ ] **Step 6: 跑测试验证工具链通**

Run: `pnpm --filter @app/runtime test`
Expected: PASS，1 passed（smoke）。

- [ ] **Step 7: Commit**

```bash
git add apps/runtime/package.json apps/runtime/tsconfig.json apps/runtime/vitest.config.ts apps/runtime/test/smoke.test.ts pnpm-lock.yaml
git commit -m "chore(runtime): 初始化 @app/runtime 包骨架与 vitest"
```

---

## Task 3: `config.ts` — 环境 → RuntimeConfig

**Files:**
- Create: `apps/runtime/src/agent/config.ts`
- Test: `apps/runtime/test/config.test.ts`

- [ ] **Step 1: 写失败测试 `apps/runtime/test/config.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/agent/config.js";

describe("loadConfig", () => {
  it("throws when ANTHROPIC_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow("ANTHROPIC_API_KEY is required");
  });

  it("parses env into a RuntimeConfig", () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      RUNTIME_DEFAULT_MODEL: "MiniMax-M3",
      PORT: "8080",
      INCLUDE_PARTIAL_MESSAGES: "1",
      JAEGER_BASE_URL: "http://localhost:16686",
    });
    expect(cfg).toEqual({
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
      defaultModel: "MiniMax-M3",
      includePartial: true,
      jaegerBaseUrl: "http://localhost:16686",
      port: 8080,
      cwd: "/workspace",
    });
  });

  it("applies defaults when optional env is absent", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(cfg.port).toBe(8080);
    expect(cfg.cwd).toBe("/workspace");
    expect(cfg.includePartial).toBe(false);
    expect(cfg.anthropicBaseUrl).toBeUndefined();
    expect(cfg.defaultModel).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @app/runtime test config`
Expected: FAIL，报无法解析 `../src/agent/config.js`（模块不存在）。

- [ ] **Step 3: 写实现 `apps/runtime/src/agent/config.ts`**

```ts
export interface RuntimeConfig {
  anthropicBaseUrl: string | undefined;
  anthropicApiKey: string;
  defaultModel: string | undefined;
  includePartial: boolean;
  jaegerBaseUrl: string | undefined;
  port: number;
  cwd: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  return {
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    anthropicApiKey,
    defaultModel: env.RUNTIME_DEFAULT_MODEL || undefined,
    includePartial: env.INCLUDE_PARTIAL_MESSAGES === "1",
    jaegerBaseUrl: env.JAEGER_BASE_URL || undefined,
    port: Number(env.PORT) || 8080,
    cwd: env.RUNTIME_CWD || "/workspace",
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @app/runtime test config`
Expected: PASS，3 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/agent/config.ts apps/runtime/test/config.test.ts
git commit -m "feat(runtime): loadConfig 从环境解析 RuntimeConfig"
```

---

## Task 4: `runtime.ts` — runTurn 驱动 query + 事件映射

**Files:**
- Create: `apps/runtime/src/agent/runtime.ts`
- Create: `apps/runtime/test/helpers.ts`
- Test: `apps/runtime/test/runtime.test.ts`
- Delete: `apps/runtime/test/smoke.test.ts`（真实测试已就位，移除占位冒烟）

- [ ] **Step 1: 写测试夹具 `apps/runtime/test/helpers.ts`**

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../src/agent/config.js";
import type { QueryFn } from "../src/agent/runtime.js";

export const testConfig: RuntimeConfig = {
  anthropicApiKey: "sk-test",
  anthropicBaseUrl: undefined,
  defaultModel: "MiniMax-M3",
  includePartial: false,
  jaegerBaseUrl: undefined,
  port: 8080,
  cwd: "/workspace",
};

// 一个成功单轮的最小消息序列：init -> assistant(text + tool_use) -> user(tool_result) -> result(success)
export const sampleMessages: SDKMessage[] = [
  {
    type: "system",
    subtype: "init",
    uuid: "u-init",
    session_id: "sess-1",
    model: "MiniMax-M3",
    cwd: "/workspace",
    tools: ["Bash", "Read"],
  },
  {
    type: "assistant",
    uuid: "u-asst",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
  {
    type: "user",
    uuid: "u-user",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "a.txt", is_error: false }],
    },
  },
  {
    type: "result",
    subtype: "success",
    uuid: "u-result",
    session_id: "sess-1",
    is_error: false,
    num_turns: 1,
    duration_ms: 5,
    duration_api_ms: 4,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: {},
    result: "hello",
    permission_denials: [],
  },
] as unknown as SDKMessage[];

export function fakeQueryFn(messages: SDKMessage[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}
```

> `as unknown as SDKMessage[]`：这些是手搓的最小桩消息，不必满足完整类型；映射逻辑只读我们断言到的字段。

- [ ] **Step 2: 写失败测试 `apps/runtime/test/runtime.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { runTurn } from "../src/agent/runtime.js";
import { fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

describe("runTurn", () => {
  it("maps SDK messages into ordered SSE events", async () => {
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(sampleMessages))) {
      events.push(e);
    }
    expect(events.map((e) => e.event)).toEqual(["init", "assistant", "tool_result", "result"]);
    expect(events[0]?.data).toMatchObject({ sessionId: "sess-1", model: "MiniMax-M3" });
    expect(events[1]?.data).toMatchObject({ text: "hello" });
    expect(events[3]?.data).toMatchObject({ sessionId: "sess-1", total_cost_usd: 0.01 });
  });

  it("captures tool_use blocks in the assistant event", async () => {
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(sampleMessages))) {
      events.push(e);
    }
    const asst = events.find((e) => e.event === "assistant");
    expect(asst?.data.toolUses).toEqual([{ id: "tu-1", name: "Bash", input: { command: "ls" } }]);
  });

  it("maps a result error subtype into an error event", async () => {
    const errMsgs = [
      { type: "system", subtype: "init", uuid: "i", session_id: "s", model: "m", cwd: "/workspace", tools: [] },
      {
        type: "result",
        subtype: "error_during_execution",
        uuid: "e",
        session_id: "s",
        is_error: true,
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        errors: ["boom"],
      },
    ] as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage[];
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(errMsgs))) {
      events.push(e);
    }
    const err = events.find((e) => e.event === "error");
    expect(err?.data).toMatchObject({ subtype: "error_during_execution", errors: ["boom"] });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @app/runtime test runtime`
Expected: FAIL，无法解析 `../src/agent/runtime.js`。

- [ ] **Step 4: 写实现 `apps/runtime/src/agent/runtime.ts`**

```ts
import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "./config.js";

export type SseEventName = "init" | "assistant" | "tool_result" | "result" | "error";

export interface SseEvent {
  event: SseEventName;
  data: Record<string, unknown>;
  id?: string;
}

export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface RunTurnInput {
  prompt: string;
  model?: string;
  resumeId?: string;
}

// 把 process.env（值可能 undefined）规整为 query() 需要的 Record<string,string>，再叠加运行时覆盖。
function buildChildEnv(cfg: RuntimeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  if (cfg.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = cfg.anthropicBaseUrl;
  env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? "/claude-config";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

function mapMessage(m: SDKMessage): SseEvent | null {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        return {
          event: "init",
          id: m.uuid,
          data: { sessionId: m.session_id, model: m.model, cwd: m.cwd, tools: m.tools },
        };
      }
      return null;
    case "assistant": {
      const text: string[] = [];
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      for (const block of m.message.content) {
        if (block.type === "text") {
          text.push(block.text);
        } else if (block.type === "tool_use") {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }
      return { event: "assistant", id: m.uuid, data: { text: text.join(""), toolUses } };
    }
    case "user": {
      const content = m.message.content;
      if (!Array.isArray(content)) return null;
      const results: Array<{ toolUseId: string; isError: boolean }> = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          results.push({ toolUseId: block.tool_use_id, isError: block.is_error ?? false });
        }
      }
      return results.length > 0 ? { event: "tool_result", data: { results } } : null;
    }
    case "result":
      if (m.subtype === "success") {
        return {
          event: "result",
          id: m.uuid,
          data: {
            sessionId: m.session_id,
            usage: m.usage,
            total_cost_usd: m.total_cost_usd,
            modelUsage: m.modelUsage,
            num_turns: m.num_turns,
            is_error: m.is_error,
          },
        };
      }
      return {
        event: "error",
        id: m.uuid,
        data: { subtype: m.subtype, errors: m.errors },
      };
    default:
      return null;
  }
}

export async function* runTurn(
  input: RunTurnInput,
  cfg: RuntimeConfig,
  queryFn: QueryFn = defaultQuery,
): AsyncGenerator<SseEvent> {
  const options: Options = {
    cwd: cfg.cwd,
    model: input.model ?? cfg.defaultModel,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    includePartialMessages: cfg.includePartial,
    env: buildChildEnv(cfg),
    ...(input.resumeId ? { resume: input.resumeId } : {}),
  };

  for await (const m of queryFn({ prompt: input.prompt, options })) {
    const evt = mapMessage(m);
    if (evt) yield evt;
  }
}
```

> **类型坑预案：** ① `allowDangerouslySkipPermissions` 研究确认是 `bypassPermissions` 的必填伴随项；若安装的 `.d.ts` 不含该键导致多余属性报错，先 `pnpm --filter @app/runtime exec tsc --noEmit` 看真实类型，再据实调整（必要时该项放进 `env` 或用 `satisfies`）。② `m.message.content` 的 block 联合类型若窄化不出 `tool_use`/`tool_result`，按安装版本的内容块类型名核对（`block.type` 判别字段稳定）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @app/runtime test runtime`
Expected: PASS，3 passed。

- [ ] **Step 6: 删除临时冒烟测试并确认类型通过**

Run: `git rm apps/runtime/test/smoke.test.ts; pnpm --filter @app/runtime typecheck`
Expected: `tsc --noEmit` 退出码 0（无类型错误）。

- [ ] **Step 7: Commit**

```bash
git add apps/runtime/src/agent/runtime.ts apps/runtime/test/helpers.ts apps/runtime/test/runtime.test.ts
git commit -m "feat(runtime): runTurn 驱动 query 并把 SDKMessage 映射为 SSE 事件"
```

---

## Task 5: `server.ts` — Hono 路由（healthz / config / POST /sessions）

**Files:**
- Create: `apps/runtime/src/server.ts`
- Test: `apps/runtime/test/server.test.ts`

- [ ] **Step 1: 写失败测试 `apps/runtime/test/server.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

describe("createServer", () => {
  it("GET /healthz returns ok", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]) });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /config returns the playground config shape", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), version: "1.2.3" });
    const res = await app.request("/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      defaultModel: "MiniMax-M3",
      jaegerBaseUrl: null,
      version: "1.2.3",
      includePartial: false,
    });
  });

  it("POST /sessions with no prompt returns 400", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]) });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions streams mapped SSE events", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn(sampleMessages) });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: init");
    expect(text).toContain("event: assistant");
    expect(text).toContain("event: result");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @app/runtime test server`
Expected: FAIL，无法解析 `../src/server.js`。

- [ ] **Step 3: 写实现 `apps/runtime/src/server.ts`**

```ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RuntimeConfig } from "./agent/config.js";
import { type QueryFn, runTurn } from "./agent/runtime.js";

export interface ServerDeps {
  config: RuntimeConfig;
  queryFn?: QueryFn;
  version?: string;
}

export function createServer(deps: ServerDeps): Hono {
  const { config, queryFn, version = "0.0.0" } = deps;
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/config", (c) =>
    c.json({
      defaultModel: config.defaultModel ?? null,
      jaegerBaseUrl: config.jaegerBaseUrl ?? null,
      version,
      includePartial: config.includePartial,
    }),
  );

  app.post("/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: unknown; model?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt) {
      return c.json({ error: "prompt is required" }, 400);
    }
    const model = typeof body.model === "string" ? body.model : undefined;

    return streamSSE(c, async (stream) => {
      try {
        for await (const evt of runTurn({ prompt, model }, config, queryFn)) {
          if (stream.aborted) break;
          await stream.writeSSE({
            event: evt.event,
            data: JSON.stringify(evt.data),
            ...(evt.id ? { id: evt.id } : {}),
          });
        }
      } catch (err) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: String(err) }) });
      }
    });
  });

  return app;
}
```

> `runTurn` 第三参 `queryFn` 为 `undefined` 时走默认参数（真实 `query`）；测试注入假 `queryFn`，无需真实 API Key。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @app/runtime test server`
Expected: PASS，4 passed。

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `pnpm --filter @app/runtime test; pnpm --filter @app/runtime typecheck`
Expected: 全部 PASS（config + runtime + server），`tsc --noEmit` 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add apps/runtime/src/server.ts apps/runtime/test/server.test.ts
git commit -m "feat(runtime): Hono 路由 healthz/config/POST /sessions(SSE)"
```

---

## Task 6: `index.ts` 入口 + 编译产物验证

**Files:**
- Create: `apps/runtime/src/index.ts`

- [ ] **Step 1: 写入口 `apps/runtime/src/index.ts`**

```ts
import { serve } from "@hono/node-server";
import { loadConfig } from "./agent/config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const app = createServer({ config, version: process.env.npm_package_version });

const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`runtime listening on http://0.0.0.0:${info.port}`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

> 入口含启动副作用，不做单测；用「编译 + 本地启动冒烟」验证。

- [ ] **Step 2: 编译产出 dist**

Run: `pnpm --filter @app/runtime build`
Expected: 生成 `apps/runtime/dist/index.js` 等，`tsc` 退出码 0。

- [ ] **Step 3: 本地启动冒烟（假 Key 即可，只验证起监听）**

PowerShell：

```powershell
$env:ANTHROPIC_API_KEY = "sk-fake"; $env:PORT = "8080"; node apps/runtime/dist/index.js
```

Expected: 打印 `runtime listening on http://0.0.0.0:8080`。另开一个终端：

```powershell
curl http://localhost:8080/healthz
```

Expected: `{"status":"ok"}`。验证完 `Ctrl+C` 停掉。

> 此处只验证 HTTP 起得来；真正调用模型的端到端冒烟在 Task 8（需真实 Key + 容器）。

- [ ] **Step 4: Biome 全量检查**

Run: `pnpm run check`
Expected: 自动修复格式/导入顺序后退出码 0；若有改动一并纳入下一次提交。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/index.ts
git commit -m "feat(runtime): 服务入口 loadConfig + @hono/node-server serve"
```

---

## Task 7: 容器化 — Dockerfile / entrypoint / 固定 guidelines

**Files:**
- Create: `.dockerignore`（仓库根）
- Create: `apps/runtime/Dockerfile`
- Create: `apps/runtime/container/entrypoint.sh`
- Create: `apps/runtime/container/agent-CLAUDE.md`
- Create: `.env.example`

- [ ] **Step 1: 写 `.env.example`（仓库根，无真实密钥）**

```bash
# ---- 模型后端（Agent SDK / CLI 透传）----
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
ANTHROPIC_API_KEY=sk-replace-me
RUNTIME_DEFAULT_MODEL=MiniMax-M3

# ---- 服务自身 ----
PORT=8080
JAEGER_BASE_URL=http://localhost:16686
INCLUDE_PARTIAL_MESSAGES=0

# ---- 容器内 agent 的 VCS 认证（复用本机 gh：用 `gh auth token` 取值填入）----
GH_TOKEN=
GIT_AUTHOR_NAME=
GIT_AUTHOR_EMAIL=
GIT_COMMITTER_NAME=
GIT_COMMITTER_EMAIL=
```

> `.gitignore` 已忽略 `.env` 且放行 `!.env.example`，密钥不会被提交。

- [ ] **Step 2: 写根 `.dockerignore`**

> ⚠️ 必须放仓库根：`docker build` 上下文是仓库根（见 Step 6），Docker 只读取**上下文根**的 `.dockerignore`，放在 `apps/runtime/` 下不会生效。若不排除，`COPY . .` 会把宿主（Windows）的 `node_modules` 覆盖进镜像，损坏自带 CLI 的原生依赖。

```
node_modules
**/node_modules
dist
**/dist
.git
.env
.env.*
.run
*.log
```

- [ ] **Step 3: 写固定 guidelines `apps/runtime/container/agent-CLAUDE.md`（= 根 `CLAUDE.md` 内容）**

直接复制根 `CLAUDE.md`（内容相同，spec §3.2.2）：

Run: `Copy-Item CLAUDE.md apps/runtime/container/agent-CLAUDE.md`
Expected: 文件生成，内容与根 `CLAUDE.md` 逐字一致。

- [ ] **Step 4: 写 `apps/runtime/container/entrypoint.sh`**

```bash
#!/usr/bin/env bash
# Runtime 容器入口：幂等写 CLAUDE.md + 配置 git/gh 认证 + 起服务。
set -euo pipefail

# 1) 把镜像内置的固定 guidelines 幂等写到 user-level CLAUDE.md（settingSources:['user'] 从这里读）。
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/claude-config}"
SRC_GUIDELINES="/app/apps/runtime/container/agent-CLAUDE.md"
DEST_GUIDELINES="${CLAUDE_CONFIG_DIR}/CLAUDE.md"

mkdir -p "${CLAUDE_CONFIG_DIR}"
if [ -f "${SRC_GUIDELINES}" ]; then
  if ! cmp -s "${SRC_GUIDELINES}" "${DEST_GUIDELINES}" 2>/dev/null; then
    cp -f "${SRC_GUIDELINES}" "${DEST_GUIDELINES}"
    echo "[entrypoint] wrote ${DEST_GUIDELINES}"
  fi
else
  echo "[entrypoint] WARNING: ${SRC_GUIDELINES} not found, skipping CLAUDE.md init" >&2
fi

# 2) 若提供 GH_TOKEN，让 git push/clone 也走 gh 凭据。
if [ -n "${GH_TOKEN:-}" ]; then
  echo "[entrypoint] configuring git to use gh credentials"
  gh auth setup-git
fi

# 3) exec node 成为 PID 1，正确转发 SIGTERM/SIGINT 做优雅停止。
exec node /app/apps/runtime/dist/index.js
```

- [ ] **Step 5: 写 `apps/runtime/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# 基础镜像：Node 22 LTS on Debian 12 (bookworm)。用 slim 非 alpine —— SDK 自带 CLI 依赖 glibc/libstdc++。
FROM node:22-bookworm-slim

# ---- 系统层：编码工具 + gh（GitHub 官方 keyring apt 源）----
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        git \
        ripgrep \
        curl \
        ca-certificates \
        wget \
        gnupg \
        libstdc++6; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    out=$(mktemp); \
    wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
    cat "$out" | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    mkdir -p -m 755 /etc/apt/sources.list.d; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*

# ---- uv（astral 官方脚本）+ Python 3.12（装到系统 PATH，非 root 用户也能用）----
RUN set -eux; \
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_UNMANAGED_INSTALL=/usr/local/bin sh; \
    uv python install 3.12 --default

# ---- corepack 启用 pnpm（关下载交互提示，避免 build hang）----
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# ---- 固定 UID/GID 非 root 用户（与 bind mount chown 对齐）----
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash app

# ---- 应用目录 + 可挂载目录 ----
WORKDIR /app
RUN mkdir -p /workspace /claude-config \
    && chown -R app:app /app /workspace /claude-config

# ---- 先 COPY manifest 利用层缓存 ----
COPY --chown=app:app pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY --chown=app:app apps/runtime/package.json ./apps/runtime/package.json

USER app
RUN pnpm install --frozen-lockfile --filter @app/runtime...

# ---- COPY 剩余源码并编译 ----
COPY --chown=app:app . .
RUN pnpm --filter @app/runtime build

# entrypoint 需要可执行位（COPY 不保证保留）
USER root
RUN chmod +x /app/apps/runtime/container/entrypoint.sh
USER app

# ---- 运行时 ENV ----
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/claude-config \
    HOME=/home/app \
    PORT=8080 \
    PATH=/home/app/.local/share/pnpm:/home/app/.local/bin:/usr/local/bin:$PATH

EXPOSE 8080

ENTRYPOINT ["/app/apps/runtime/container/entrypoint.sh"]
```

> 关键点（研究核实）：gh 安装命令逐字来自 `cli/cli` 官方文档但去掉 `sudo`（RUN 默认 root）；uv 用 `UV_INSTALL_DIR=/usr/local/bin` 装到系统 PATH，且 `uv python install` 在 root 阶段跑；`--frozen-lockfile` 保证可复现且**不裁 SDK optional 依赖**（否则自带 CLI 无法 spawn）；末尾 `exec node` 让 node 成 PID 1。

- [ ] **Step 6: 构建镜像验证**

在仓库根执行（Dockerfile 在 `apps/runtime/`，上下文是仓库根以便访问 workspace manifest）：

Run: `docker build -f apps/runtime/Dockerfile -t coding-agent-runtime:p0 .`
Expected: 构建成功，无报错；最后一层为 ENTRYPOINT。

> 若本机 corepack 旧导致 pnpm 签名校验失败，按研究 gotcha：在 Dockerfile `corepack enable` 前加 `RUN npm i -g corepack@latest`。

- [ ] **Step 7: Commit**

```bash
git add .env.example .dockerignore apps/runtime/Dockerfile apps/runtime/container/
git commit -m "feat(runtime): 容器化 Dockerfile + entrypoint + 固定 guidelines"
```

---

## Task 8: 验收冒烟 — docker run 端到端单轮（需真实密钥 + Docker）

**Files:** 无新增（验收步骤）。

> 这是 spec §12 P0 验收：「本地 `docker run` 后 `POST /sessions` 能流式返回 agent 输出；容器内 agent 遵循固定 guidelines」。需要可用的 `ANTHROPIC_API_KEY`（或 MiniMax 端点）。

- [ ] **Step 1: 准备 `.env` 与挂载目录**

```bash
cp .env.example .env
# 编辑 .env 填入真实 ANTHROPIC_API_KEY（及可选 ANTHROPIC_BASE_URL / GH_TOKEN）
```

准备宿主挂载目录并对齐容器 UID/GID（10001）。Linux/WSL：

```bash
mkdir -p ./.run/workspace ./.run/claude-config
sudo chown -R 10001:10001 ./.run/workspace ./.run/claude-config
```

> Windows + Docker Desktop（WSL2 后端）：在 WSL 文件系统内建目录并 `chown`，挂载该路径；NTFS 路径权限模型不同，可能无需 chown 但建议用 WSL 路径。

- [ ] **Step 2: 起容器**

```bash
docker run --rm -p 8080:8080 \
  --env-file .env \
  -e CLAUDE_CONFIG_DIR=/claude-config \
  -v "$(pwd)/.run/workspace:/workspace" \
  -v "$(pwd)/.run/claude-config:/claude-config" \
  coding-agent-runtime:p0
```

Expected: 日志出现 `[entrypoint] wrote /claude-config/CLAUDE.md`，随后 `runtime listening on http://0.0.0.0:8080`。

- [ ] **Step 3: 验证固定 guidelines 已落地**

```bash
docker exec "$(docker ps -q --filter ancestor=coding-agent-runtime:p0)" cat /claude-config/CLAUDE.md
```

Expected: 输出与根 `CLAUDE.md` 一致（4 节行为规范）。

- [ ] **Step 4: 端到端 SSE 单轮**

```bash
curl -N -X POST http://localhost:8080/sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"用一句话说明你会遵循哪些编码 guidelines，然后在 /workspace 建一个 hello.txt 写入 hi"}'
```

Expected: 看到流式 `event: init`（含 sessionId/model/cwd=/workspace/tools）→ 若干 `event: assistant`（文本 + 可能的 `tool_use`）→ `event: tool_result` → `event: result`（含 usage/total_cost_usd/num_turns）。验证 `./.run/workspace/hello.txt` 已生成。

- [ ] **Step 5: 记录结果**

确认验收通过（流式返回 + guidelines 生效 + 文件改动落在挂载 `/workspace`）。若用 MiniMax 端点，注意 `total_cost_usd` 估算可能失真（仅 token 可信，见 spec §7.3）。

> 本步依赖真实密钥/网络/Docker，属手动验收，不进 CI。

---

## P0 完成标准

- [ ] `pnpm --filter @app/runtime test` 全绿（config + runtime + server）。
- [ ] `pnpm --filter @app/runtime typecheck` 与 `pnpm run check` 均退出码 0。
- [ ] `docker build` 成功。
- [ ] `docker run` 后 `POST /sessions` 流式返回 agent 输出，`/claude-config/CLAUDE.md` 为固定 guidelines，改动落在挂载 `/workspace`（Task 8 验收）。

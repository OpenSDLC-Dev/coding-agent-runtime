import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RuntimeConfig } from "../agent/config.js";
import { isModelAllowed } from "../agent/config.js";
import { type QueryFn, runTurn, type SseEvent } from "../agent/runtime.js";
import {
  extractChangedFiles,
  type SessionRecord,
  type SessionRegistry,
} from "../agent/session-store.js";
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

// 注入式 SDK 句柄（测试传假实现；生产由 server.ts 默认接真 SDK）。
export interface SessionSdk {
  getSessionInfo?: (
    id: string,
    opts: { dir: string },
  ) => Promise<
    { sessionId: string; summary: string; cwd?: string; gitBranch?: string } | undefined
  >;
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

// 共享一轮流式执行：先 next() 一次拿 init 事件并写入 registry，再流式输出全部事件。
// 用 next() 而非 for-await+break 避免关闭 generator（break 会触发 return()）。
// 这样在 await streamTurn() 解析后，registry 里的 sessionId 就已经就绪（测试无需读 body）。
async function streamTurn(
  c: Context,
  input: { prompt: string; model?: string; resumeId?: string },
  deps: SessionRouteDeps,
): Promise<Response> {
  const abortController = new AbortController();
  const gen = runTurn({ ...input, abortController }, deps.config, deps.queryFn);

  // 预读第一个事件（通常是 init），登记 session；不用 break 避免关闭 generator。
  let sid = input.resumeId;
  let firstEvt: SseEvent | undefined;

  try {
    const step = await gen.next();
    if (!step.done) {
      firstEvt = step.value;
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
    }
  } catch (preErr) {
    // 预读失败：通过 SSE 将错误通知客户端，避免静默空流。
    const correlationId = randomUUID();
    console.error(`[sessions] pre-read error correlationId=${correlationId}:`, preErr);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: "internal error", correlationId }),
      });
    });
  }

  return streamSSE(c, async (stream) => {
    // 先写出预读的第一个事件
    if (firstEvt && !stream.aborted) {
      await stream.writeSSE({
        event: firstEvt.event,
        data: JSON.stringify(firstEvt.data),
        ...(firstEvt.id ? { id: firstEvt.id } : {}),
      });
    }
    try {
      // 继续消费剩余事件
      for await (const evt of gen) {
        if (stream.aborted) break;
        if (evt.event === "assistant" && sid) {
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
        await stream.writeSSE({
          event: "aborted",
          data: JSON.stringify({ sessionId: sid ?? null }),
        });
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

  // ---- REST 端点 ----

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
          ...(info ? { summary: info.summary, cwd: info.cwd, gitBranch: info.gitBranch } : {}),
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
        200: {
          description: "是否成功中止",
          content: { "application/json": { schema: StopResponse } },
        },
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
}

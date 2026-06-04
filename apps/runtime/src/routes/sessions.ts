import { randomUUID } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RuntimeConfig } from "../agent/config.js";
import { isModelAllowed } from "../agent/config.js";
import { type QueryFn, runTurn, type SseEvent } from "../agent/runtime.js";
import { extractChangedFiles, type SessionRegistry } from "../agent/session-store.js";
import { CreateSessionBody, SseEventSchema } from "../schemas/index.js";

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
    }
  } catch {
    // pre-read error: fall through to streamSSE error handler
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
}

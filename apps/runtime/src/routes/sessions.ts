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

// Injectable SDK handle (tests pass a fake implementation; in production server.ts wires the real SDK by default).
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

// SSE heartbeat: write a comment line ": keepalive\n\n" every `ms` to prevent reverse-proxy idle disconnects (spec §4.2/§5).
// Extracted into a standalone function so it can be unit-tested with a fake timer; the whole comment is written at once (atomic block, not interleaved with writeSSE to avoid breaking frames).
export interface HeartbeatStream {
  readonly aborted: boolean;
  readonly closed: boolean;
  write(input: string): Promise<unknown>;
}

export function startHeartbeat(stream: HeartbeatStream, ms: number): () => void {
  if (ms <= 0) return () => {};
  const timer = setInterval(() => {
    if (stream.aborted || stream.closed) return;
    void stream.write(": keepalive\n\n").catch(() => {});
  }, ms);
  // Belt and suspenders: stream end will clearInterval; unref prevents an idle timer from holding the process open.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

// Shared single-turn streaming execution: call next() once to grab the init event and write it into the registry, then stream out all events.
// Use next() rather than for-await+break to avoid closing the generator (break triggers return()).
// This way, after `await streamTurn()` resolves, the sessionId in the registry is already ready (tests don't need to read the body).
async function streamTurn(
  c: Context,
  input: { prompt: string; model?: string; resumeId?: string },
  deps: SessionRouteDeps,
): Promise<Response> {
  const abortController = new AbortController();
  const gen = runTurn({ ...input, abortController }, deps.config, deps.queryFn);

  // Pre-read the first event (usually init), register the session; don't use break to avoid closing the generator.
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
      // Surface this turn's traceId in the response header (the frontend can deep-link to Jaeger from it; requires CORS exposeHeaders).
      const traceId = firstEvt.data.traceId;
      if (typeof traceId === "string") c.header("X-Trace-Id", traceId);
    }
  } catch (preErr) {
    // Pre-read failed: notify the client of the error over SSE to avoid a silent empty stream.
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
    const stopHeartbeat = startHeartbeat(stream, deps.config.heartbeatMs);
    try {
      // First write out the pre-read first event
      if (firstEvt && !stream.aborted) {
        await stream.writeSSE({
          event: firstEvt.event,
          data: JSON.stringify(firstEvt.data),
          ...(firstEvt.id ? { id: firstEvt.id } : {}),
        });
      }
      try {
        // Continue consuming the remaining events
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
    } finally {
      stopHeartbeat();
    }
  });
}

export function registerSessionRoutes(app: OpenAPIHono, deps: SessionRouteDeps): void {
  const { config } = deps;

  // ---- OpenAPI registration (SSE endpoints use registerPath to manually register the single-event payload) ----
  for (const path of ["/sessions", "/sessions/{id}/turns"]) {
    app.openAPIRegistry.registerPath({
      method: "post",
      path,
      summary:
        path === "/sessions"
          ? "Create a session and run the first turn (SSE)"
          : "Append a turn (resume, SSE)",
      tags: ["sessions"],
      request: {
        body: { content: { "application/json": { schema: CreateSessionBody } } },
      },
      responses: {
        200: {
          description:
            "text/event-stream: this turn's events (see schema for the single-event payload)",
          content: { "text/event-stream": { schema: SseEventSchema } },
        },
        400: { description: "prompt is missing or model is not on the allowlist" },
        404: { description: "session does not exist (turns only)" },
      },
    });
  }

  // ---- POST /sessions: first turn ----
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

  // ---- POST /sessions/:id/turns: continuation ----
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

  // ---- REST endpoints ----

  // Project a registry record into a list item (use null for model to be compatible with the schema's nullable).
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
      summary: "List sessions (runtime-state view)",
      responses: {
        200: {
          description: "Session list",
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
      summary: "Session info (registry + on-disk getSessionInfo)",
      request: { params: SessionIdParam },
      responses: {
        200: {
          description: "Session info",
          content: { "application/json": { schema: SessionInfo } },
        },
        404: {
          description: "Not found",
          content: { "application/json": { schema: ErrorResponse } },
        },
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
      summary: "Full transcript (getSessionMessages)",
      request: { params: SessionIdParam },
      responses: {
        200: {
          description: "Message list",
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
      summary: "Abort the current turn (abortController.abort())",
      request: { params: SessionIdParam },
      responses: {
        200: {
          description: "Whether the abort succeeded",
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
      summary: "Delete a session (on-disk deleteSession + clear registry)",
      request: { params: SessionIdParam },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: DeleteResponse } },
        },
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

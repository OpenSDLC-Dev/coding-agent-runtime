import { randomUUID } from "node:crypto";
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
        // 服务端记全量错误，客户端只回通用 message + correlationId（不泄露内部细节）。
        const correlationId = randomUUID();
        console.error(`[/sessions] error correlationId=${correlationId}:`, err);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "internal error", correlationId }),
        });
      }
    });
  });

  return app;
}

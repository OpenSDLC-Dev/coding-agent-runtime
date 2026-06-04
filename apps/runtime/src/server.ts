import { deleteSession, getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
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
      origin: config.corsOrigins === "*" ? "*" : config.corsOrigins.split(",").map((s) => s.trim()),
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

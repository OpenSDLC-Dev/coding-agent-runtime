import { deleteSession, getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { RuntimeConfig } from "./agent/config.js";
import type { QueryFn } from "./agent/runtime.js";
import { startSessionGc } from "./agent/session-gc.js";
import { SessionRegistry } from "./agent/session-store.js";
import type { ExtensionContributions } from "./extensions/types.js";
import { registerSessionRoutes, type SessionSdk } from "./routes/sessions.js";

export interface ServerDeps {
  config: RuntimeConfig;
  queryFn?: QueryFn;
  registry?: SessionRegistry;
  sdk?: SessionSdk;
  version?: string;
  contributions?: ExtensionContributions;
}

export function createServer(deps: ServerDeps): OpenAPIHono {
  const { config, version = "0.0.0" } = deps;
  const registry = deps.registry ?? new SessionRegistry();
  const sdk: SessionSdk = deps.sdk ?? { getSessionInfo, getSessionMessages, deleteSession };

  // Reclaim idle sessions' on-disk transcripts so a long-running container's disk does not fill up.
  // No-op (and leaks no timer) unless RUNTIME_SESSION_TTL_MS > 0; the interval is unref()'d.
  startSessionGc(registry, sdk, config);

  const app = new OpenAPIHono();

  app.use(
    "*",
    cors({
      origin: config.corsOrigins === "*" ? "*" : config.corsOrigins.split(",").map((s) => s.trim()),
      exposeHeaders: ["X-Trace-Id"],
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
      // The reasoning effort and turn backstop in force for this runtime. Exposed so an external
      // benchmark harness can authoritatively snapshot the run's config tuple (these are operational,
      // non-secret settings); the model backend URL is deliberately NOT exposed.
      effort: config.effort,
      maxTurns: config.maxTurns,
    }),
  );

  registerSessionRoutes(app, {
    config,
    queryFn: deps.queryFn,
    registry,
    sdk,
    version,
    contributions: deps.contributions,
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Coding Agent Runtime", version },
  });
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  return app;
}

import { OpenAPIHono } from "@hono/zod-openapi";
import type { RuntimeConfig } from "./agent/config.js";
import type { QueryFn } from "./agent/runtime.js";
import { SessionRegistry } from "./agent/session-store.js";
import { registerSessionRoutes } from "./routes/sessions.js";

export interface ServerDeps {
  config: RuntimeConfig;
  queryFn?: QueryFn;
  version?: string;
}

export function createServer(deps: ServerDeps): OpenAPIHono {
  const { config, queryFn, version = "0.0.0" } = deps;
  const app = new OpenAPIHono();
  const registry = new SessionRegistry();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/config", (c) =>
    c.json({
      defaultModel: config.defaultModel ?? null,
      jaegerBaseUrl: config.jaegerBaseUrl ?? null,
      version,
      includePartial: config.includePartial,
    }),
  );

  registerSessionRoutes(app, { config, registry, queryFn, sdk: {}, version });

  return app;
}

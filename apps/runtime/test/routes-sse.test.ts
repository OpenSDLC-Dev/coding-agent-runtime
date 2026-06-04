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

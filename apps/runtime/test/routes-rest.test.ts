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
        id === "disk-only" ? { sessionId: id, summary: "from disk", cwd: "/workspace" } : undefined,
    };
    const { app, registry } = makeApp(sdk);
    registry.startTurn("s1", { model: "m", abortController: new AbortController() });
    const r1 = await app.request("/sessions/s1");
    expect(r1.status).toBe(200);
    const r2 = await app.request("/sessions/disk-only");
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { summary?: string }).summary).toBe("from disk");
    const r3 = await app.request("/sessions/nope");
    expect(r3.status).toBe(404);
  });

  it("GET /sessions/:id/transcript returns getSessionMessages output", async () => {
    const sdk: SessionSdk = {
      getSessionMessages: async () => [
        {
          type: "user",
          uuid: "u1",
          session_id: "s1",
          message: { role: "user" },
          parent_tool_use_id: null,
        },
      ],
    };
    const { app } = makeApp(sdk);
    const res = await app.request("/sessions/s1/transcript");
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(1);
  });

  it("POST /sessions/:id/stop aborts an active turn", async () => {
    const { app, registry } = makeApp();
    const ac = new AbortController();
    registry.startTurn("s1", { model: "m", abortController: ac });
    const res = await app.request("/sessions/s1/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopped: boolean }).stopped).toBe(true);
    expect(ac.signal.aborted).toBe(true);
  });

  it("DELETE /sessions/:id removes from registry and calls deleteSession", async () => {
    let deleted = "";
    const sdk: SessionSdk = {
      deleteSession: async (id) => {
        deleted = id;
      },
    };
    const { app, registry } = makeApp(sdk);
    registry.startTurn("s1", { model: "m", abortController: new AbortController() });
    const res = await app.request("/sessions/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(registry.has("s1")).toBe(false);
    expect(deleted).toBe("s1");
  });
});

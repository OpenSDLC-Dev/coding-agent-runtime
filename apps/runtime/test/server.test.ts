import { describe, expect, it, vi } from "vitest";
import type { QueryFn } from "../src/agent/runtime.js";
import { SessionRegistry } from "../src/agent/session-store.js";
import { createServer } from "../src/server.js";
import { collectSse, fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

describe("createServer", () => {
  it("GET /healthz returns ok", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /config includes allowlist, playground, and run-config fields", async () => {
    const app = createServer({
      config: { ...testConfig, allowedModels: ["MiniMax-M3"], effort: "high", maxTurns: 42 },
      queryFn: fakeQueryFn([]),
      sdk: {},
      version: "1.2.3",
    });
    const res = await app.request("/config");
    expect(await res.json()).toEqual({
      defaultModel: "MiniMax-M3",
      allowedModels: ["MiniMax-M3"],
      jaegerBaseUrl: null,
      version: "1.2.3",
      includePartial: false,
      effort: "high",
      maxTurns: 42,
    });
  });

  it("GET /openapi.json is an OpenAPI 3.1 document covering /sessions", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/sessions", "/sessions/{id}", "/sessions/{id}/transcript"]),
    );
  });

  it("GET /docs serves Swagger UI html", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("swagger");
  });

  it("CORS preflight is allowed", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), sdk: {} });
    const res = await app.request("/config", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "GET" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("POST /sessions streams mapped SSE events end-to-end", async () => {
    const registry = new SessionRegistry();
    const app = createServer({
      config: testConfig,
      queryFn: fakeQueryFn(sampleMessages),
      sdk: {},
      registry,
    });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events } = await collectSse(res);
    expect(events).toEqual(["init", "assistant", "tool_result", "result"]);
    expect(registry.get("sess-1")?.turns).toBe(1);
  });

  it("maps a runtime error to a generic SSE error (no internal detail leaked)", async () => {
    const throwing: QueryFn = () => {
      throw new Error("boom secret internal detail");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createServer({ config: testConfig, queryFn: throwing, sdk: {} });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    const text = await res.text();
    errSpy.mockRestore();
    expect(text).toContain("event: error");
    expect(text).toContain("internal error");
    expect(text).toContain("correlationId");
    expect(text).not.toContain("boom secret internal detail");
  });
});

import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

describe("createServer", () => {
  it("GET /healthz returns ok", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]) });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /config returns the playground config shape", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]), version: "1.2.3" });
    const res = await app.request("/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      defaultModel: "MiniMax-M3",
      jaegerBaseUrl: null,
      version: "1.2.3",
      includePartial: false,
    });
  });

  it("POST /sessions with no prompt returns 400", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn([]) });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions streams mapped SSE events", async () => {
    const app = createServer({ config: testConfig, queryFn: fakeQueryFn(sampleMessages) });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: init");
    expect(text).toContain("event: assistant");
    expect(text).toContain("event: result");
  });
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryFn } from "../src/agent/runtime.js";
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

  it("forwards a /goal slash-command prompt through POST /sessions verbatim", async () => {
    // End-to-end (route → runTurn → query) guard that a slash command is streamed as a normal
    // turn and reaches the SDK unchanged; the runtime adds no loop/goal semantics of its own.
    let capturedPrompt: string | undefined;
    const capturing: QueryFn = (args) => {
      capturedPrompt = args.prompt;
      return (async function* () {
        for (const m of sampleMessages) yield m;
      })();
    };
    const { app } = makeApp({ queryFn: capturing });
    const prompt = "/goal upgrade the SDK and keep the tests green";
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    expect(res.status).toBe(200);
    const { events } = await collectSse(res);
    expect(events).toEqual(["init", "assistant", "tool_result", "result"]);
    expect(capturedPrompt).toBe(prompt);
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
    // create the session first
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

  it("emits an aborted event when the active turn is stopped mid-flight", async () => {
    // fake query: emit init then hang until abortController fires (with an already-aborted fallback to avoid missing the event).
    const queryFn: QueryFn = (args) => {
      const signal = args.options.abortController?.signal;
      return (async function* () {
        yield sampleMessages[0] as never; // init (sess-1)
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })();
    };
    const { app, registry } = makeApp({ queryFn });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    // init has been pre-read and the session is registered; abort the current turn.
    expect(registry.abort("sess-1")).toBe(true);
    const { events } = await collectSse(res);
    expect(events).toContain("aborted");
    expect(registry.get("sess-1")?.status).toBe("aborted");
  });

  it("returns 429 when at max concurrency, and readmits after the slot frees", async () => {
    // hang after init so the first turn holds its admission slot while we probe a second request.
    const hang: QueryFn = (args) => {
      const signal = args.options.abortController?.signal;
      return (async function* () {
        yield sampleMessages[0] as never; // init (sess-1)
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })();
    };
    const { app, registry } = makeApp({
      queryFn: hang,
      config: { ...testConfig, maxConcurrentTurns: 1 },
    });
    const hdr = { "Content-Type": "application/json" };
    const res1 = await app.request("/sessions", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ prompt: "a" }),
    });
    expect(res1.status).toBe(200); // slot acquired, held (stream still open on the hung turn)
    const res2 = await app.request("/sessions", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ prompt: "b" }),
    });
    expect(res2.status).toBe(429);
    expect(await res2.json()).toMatchObject({ error: "runtime at capacity" });

    // free the first turn's slot: abort it, then drain its stream so streamSSE's finally (release) runs.
    expect(registry.abort("sess-1")).toBe(true);
    await collectSse(res1);

    const res3 = await app.request("/sessions", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ prompt: "c" }),
    });
    expect(res3.status).toBe(200); // slot was readmitted after res1 freed it
    // res3 also uses the hung queryFn; abort + drain so the stream (and its slot) closes cleanly.
    registry.abort("sess-1");
    await collectSse(res3);
  });

  describe("with telemetry active", () => {
    let provider: BasicTracerProvider;

    beforeEach(() => {
      provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
      });
      trace.setGlobalTracerProvider(provider);
    });

    afterEach(async () => {
      await provider.shutdown();
      trace.disable();
    });

    it("sets X-Trace-Id response header matching the init event traceId", async () => {
      const { app } = makeApp();
      const res = await app.request("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });
      expect(res.status).toBe(200);
      const header = res.headers.get("X-Trace-Id");
      expect(header).toMatch(/^[0-9a-f]{32}$/);
      const text = await res.text();
      expect(text).toContain(`"traceId":"${header}"`);
    });
  });
});

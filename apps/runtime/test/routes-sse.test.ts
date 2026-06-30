import { OpenAPIHono } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyStore } from "../src/agent/idempotency.js";
import type { QueryFn } from "../src/agent/runtime.js";
import { SessionRegistry } from "../src/agent/session-store.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import {
  collectSse,
  drainPrompt,
  fakeQueryFn,
  partialMessages,
  recordingQueryFn,
  sampleMessages,
  testConfig,
} from "./helpers.js";

const okResultWithStructured = [
  {
    type: "system",
    subtype: "init",
    uuid: "i",
    session_id: "sess-1",
    model: "m",
    cwd: "/workspace",
    tools: [],
  },
  {
    type: "result",
    subtype: "success",
    uuid: "r",
    session_id: "sess-1",
    is_error: false,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    result: "{}",
    permission_denials: [],
    structured_output: { ok: true },
  },
] as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage[];

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
    const { text, events } = await collectSse(res);
    expect(events).toEqual(["init", "assistant", "tool_result", "result"]);
    // The tool_result frame carries the actual tool output, not just the linking id.
    expect(text).toContain('"content":"a.txt"');
    const rec = registry.get("sess-1");
    expect(rec?.turns).toBe(1);
    expect(rec?.status).toBe("idle");
    expect(rec?.inputTokens).toBe(10);
    expect(rec?.outputTokens).toBe(20);
  });

  it("POST /sessions streams token-level delta frames when the SDK emits partial messages", async () => {
    const { app } = makeApp({ queryFn: fakeQueryFn(partialMessages) });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    const { text, events } = await collectSse(res);
    expect(events).toEqual(["init", "delta", "delta", "assistant", "result"]);
    expect(text).toContain("event: delta");
    expect(text).toContain('"text":"hel"');
  });

  it("POST /sessions threads a valid outputFormat into query options and surfaces structured_output", async () => {
    const { queryFn, captured } = recordingQueryFn(okResultWithStructured);
    const { app } = makeApp({ queryFn });
    const outputFormat = { type: "json_schema", schema: { type: "object" } };
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", outputFormat }),
    });
    expect(res.status).toBe(200);
    const { text } = await collectSse(res);
    expect(captured()?.outputFormat).toEqual(outputFormat);
    expect(text).toContain('"structured_output"');
  });

  it("POST /sessions rejects a malformed outputFormat with 400", async () => {
    const { app } = makeApp();
    const bad = [
      "not-an-object",
      42,
      { type: "xml" },
      { type: "json_schema" },
      { type: "json_schema", schema: "nope" },
    ];
    for (const outputFormat of bad) {
      const res = await app.request("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", outputFormat }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("POST /sessions/:id/turns threads a valid outputFormat into query options", async () => {
    const { queryFn, captured } = recordingQueryFn(okResultWithStructured);
    const { app } = makeApp({ queryFn });
    const first = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    await collectSse(first);
    const outputFormat = { type: "json_schema", schema: { type: "object" } };
    const res = await app.request("/sessions/sess-1/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "again", outputFormat }),
    });
    expect(res.status).toBe(200);
    await collectSse(res);
    expect(captured()?.outputFormat).toEqual(outputFormat);
  });

  it("POST /sessions/:id/turns rejects a malformed outputFormat with 400", async () => {
    const { app } = makeApp();
    const first = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    await collectSse(first);
    const res = await app.request("/sessions/sess-1/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "again", outputFormat: { type: "json_schema", schema: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions accepts multimodal content and streams it to query as one user message", async () => {
    const { queryFn, capturedPrompt } = recordingQueryFn(sampleMessages);
    const { app } = makeApp({ queryFn });
    const content = [
      { type: "text", text: "describe this image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ];
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(200);
    await collectSse(res);
    const msgs = await drainPrompt(capturedPrompt());
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: "user", message: { role: "user", content } });
  });

  it("POST /sessions rejects a request with neither prompt nor content (400)", async () => {
    const { app } = makeApp();
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions rejects a request carrying both prompt and content (400)", async () => {
    const { app } = makeApp();
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", content: [{ type: "text", text: "x" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions rejects invalid or oversize content (400)", async () => {
    const { app } = makeApp();
    const oversize = "A".repeat(10 * 1024 * 1024 + 1);
    const cases: unknown[] = [
      [], // empty array
      [{ type: "audio", data: "x" }], // unknown block type
      [{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "AAAA" } }], // bad media type
      [{ type: "image", source: { type: "url", url: "http://x" } }], // non-base64 source
      [{ type: "text" }], // text block missing text
      [{ type: "image", source: { type: "base64", media_type: "image/png", data: oversize } }], // oversize
    ];
    for (const content of cases) {
      const res = await app.request("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("POST /sessions rejects more than 16 image blocks (400)", async () => {
    const { app } = makeApp();
    const content = Array.from({ length: 17 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AA" },
    }));
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sessions accepts a text block alongside the max 16 images (server cap mirrors the web)", async () => {
    const { app } = makeApp({ queryFn: fakeQueryFn(sampleMessages) });
    const content = [
      { type: "text", text: "describe these" },
      ...Array.from({ length: 16 }, () => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AA" },
      })),
    ];
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /sessions rejects an oversize request body with 413", async () => {
    const { app } = makeApp({ config: { ...testConfig, maxBodyBytes: 200 } });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(400) }),
    });
    expect(res.status).toBe(413);
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
    // create the session first, and drain its stream so the turn finishes (releases the in-flight slot)
    const first = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    await collectSse(first);
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

  // Hang after init so a turn holds its session active while we probe a duplicate.
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

  it("rejects a duplicate turn on a session that already has one in flight (409)", async () => {
    const { app, registry } = makeApp({ queryFn: hang });
    const hdr = { "Content-Type": "application/json" };
    const res1 = await app.request("/sessions", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ prompt: "a" }),
    });
    expect(res1.status).toBe(200);
    expect(registry.get("sess-1")?.status).toBe("running");
    // a second turn on the same session while the first is in flight is rejected, not run concurrently
    const res2 = await app.request("/sessions/sess-1/turns", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ prompt: "b" }),
    });
    expect(res2.status).toBe(409);
    // free the first turn so its stream + slot close cleanly
    registry.abort("sess-1");
    await collectSse(res1);
  });

  it("rejects a duplicate request carrying the same Idempotency-Key (409)", async () => {
    const { app, registry } = makeApp({
      queryFn: hang,
      idempotency: new IdempotencyStore(600_000),
    });
    const hdr = { "Content-Type": "application/json", "Idempotency-Key": "abc" };
    const res1 = await app.request("/sessions", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ prompt: "a" }),
    });
    expect(res1.status).toBe(200);
    const res2 = await app.request("/sessions", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ prompt: "a" }),
    });
    expect(res2.status).toBe(409);
    registry.abort("sess-1");
    await collectSse(res1);
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

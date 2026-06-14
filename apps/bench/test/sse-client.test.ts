import { describe, expect, it } from "vitest";
import { createHttpClient, type FetchLike, parseSse } from "../src/sse-client.js";
import { ABORTED_SSE, ERROR_SSE, SUCCESS_SSE } from "./fixtures.js";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<{ event: string; data: unknown }>> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for await (const f of parseSse(stream)) frames.push(f);
  return frames;
}

function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function fetchReturning(body: string): FetchLike {
  return async (input) => {
    if (input.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response(streamFrom([body]), { status: 200 });
  };
}

describe("parseSse", () => {
  it("parses frames split across arbitrary chunk boundaries and skips keepalive comments", async () => {
    // 7-char chunks force lines and frames to straddle boundaries.
    const frames = await collect(streamFrom(chunked(SUCCESS_SSE, 7)));
    expect(frames.map((f) => f.event)).toEqual(["init", "assistant", "result"]);
    const init = frames[0]?.data as Record<string, unknown>;
    expect(init.sessionId).toBe("sess-1");
    const result = frames[2]?.data as Record<string, unknown>;
    expect(result.num_turns).toBe(1);
  });

  it("ignores standalone comment lines", async () => {
    const frames = await collect(
      streamFrom([": keepalive\n\n", 'event: result\ndata: {"num_turns":2}\n\n']),
    );
    expect(frames.map((f) => f.event)).toEqual(["result"]);
  });

  it("leaves non-JSON data as a raw string", async () => {
    const frames = await collect(streamFrom(["event: note\ndata: hello world\n\n"]));
    expect(frames[0]?.data).toBe("hello world");
  });
});

describe("createHttpClient.runTurn", () => {
  const clientFor = (body: string) =>
    createHttpClient({ baseUrl: "http://rt/", fetchImpl: fetchReturning(body) });

  it("reduces a successful stream into a result outcome with usage and trace", async () => {
    const outcome = await clientFor(SUCCESS_SSE).runTurn({ prompt: "x" });
    expect(outcome.terminal).toBe("result");
    expect(outcome.sessionId).toBe("sess-1");
    expect(outcome.isError).toBe(false);
    expect(outcome.numTurns).toBe(1);
    expect(outcome.inputTokens).toBe(10);
    expect(outcome.outputTokens).toBe(20);
    expect(outcome.costUsd).toBeCloseTo(0.01);
    expect(outcome.traceId).toBe("trace-abc");
  });

  it("maps an error stream to terminal=error", async () => {
    const outcome = await clientFor(ERROR_SSE).runTurn({ prompt: "x" });
    expect(outcome.terminal).toBe("error");
    expect(outcome.isError).toBe(true);
  });

  it("maps an aborted stream to terminal=aborted", async () => {
    const outcome = await clientFor(ABORTED_SSE).runTurn({ prompt: "x" });
    expect(outcome.terminal).toBe("aborted");
    expect(outcome.sessionId).toBe("sess-abr");
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 500 });
    const client = createHttpClient({ baseUrl: "http://rt", fetchImpl });
    await expect(client.runTurn({ prompt: "x" })).rejects.toThrow(/HTTP 500/);
  });
});

describe("createHttpClient.health", () => {
  it("returns true when /healthz is ok", async () => {
    const fetchImpl: FetchLike = async () => new Response("ok", { status: 200 });
    const client = createHttpClient({ baseUrl: "http://rt", fetchImpl });
    expect(await client.health()).toBe(true);
  });

  it("returns false once the deadline passes without a healthy response", async () => {
    const fetchImpl: FetchLike = async () => new Response("down", { status: 503 });
    const client = createHttpClient({ baseUrl: "http://rt", fetchImpl, healthTimeoutMs: 0 });
    expect(await client.health()).toBe(false);
  });
});

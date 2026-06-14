// HTTP/SSE client that drives the runtime as a black box. This is "scripts/smoke.mjs grown up":
// same transport (Node global fetch), same chunk-buffering SSE read loop, same property that the
// runtime under test holds the API key/backend config so this client never needs them.
//
// `fetch` is injectable (FetchLike) so tests can replay recorded SSE fixtures without a live runtime,
// mirroring how runTurn injects a fake QueryFn in the runtime's own tests.

import type { TurnOutcome } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeClient {
  health(): Promise<boolean>;
  runTurn(input: { prompt: string; model?: string }): Promise<TurnOutcome>;
}

export interface HttpClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  /** Max time to wait for /healthz to come up (ms). Default 30000. */
  healthTimeoutMs?: number;
  /** Abort a single turn after this wall-clock deadline (ms). Default 120000. */
  turnTimeoutMs?: number;
}

export interface SseFrame {
  event: string;
  data: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Minimal SSE parser: buffers across chunk boundaries (like smoke.mjs), ignores comment lines
// (": keepalive" heartbeats), accumulates `event:`/`data:` fields, and dispatches a frame on each
// blank line. `data` is JSON-parsed when possible, else left as the raw string.
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let dataLines: string[] = [];

  const flush = (): SseFrame | null => {
    if (dataLines.length === 0) {
      event = "message";
      return null;
    }
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // leave data as the raw string
    }
    const frame: SseFrame = { event, data };
    event = "message";
    dataLines = [];
    return frame;
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, ""); // tolerate CRLF
    if (line.startsWith(":")) return; // comment / heartbeat
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // id / retry / unknown fields are ignored
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // keep the trailing partial line for the next chunk
      for (const rawLine of lines) {
        if (rawLine.replace(/\r$/, "") === "") {
          const frame = flush();
          if (frame) yield frame;
        } else {
          consumeLine(rawLine);
        }
      }
    }
    // Flush any trailing partial line and a pending frame (stream that did not end with a blank line).
    if (buf.replace(/\r$/, "") !== "") consumeLine(buf);
    const last = flush();
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Reduce a turn's SSE stream into a TurnOutcome: capture sessionId/traceId from any frame that
// carries them (the init frame supplies both; later frames never clobber a captured string), and
// record the terminal event (result / error / aborted) with its usage and cost.
async function reduceOutcome(stream: ReadableStream<Uint8Array>): Promise<TurnOutcome> {
  const outcome: TurnOutcome = {
    sessionId: null,
    terminal: "none",
    isError: false,
    numTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    traceId: null,
  };
  for await (const frame of parseSse(stream)) {
    const d = (frame.data ?? {}) as Record<string, unknown>;
    if (typeof d.sessionId === "string") outcome.sessionId = d.sessionId;
    if (typeof d.traceId === "string") outcome.traceId = d.traceId;
    switch (frame.event) {
      case "result": {
        outcome.terminal = "result";
        outcome.isError = d.is_error === true;
        if (typeof d.num_turns === "number") outcome.numTurns = d.num_turns;
        if (typeof d.total_cost_usd === "number") outcome.costUsd = d.total_cost_usd;
        const usage = (d.usage ?? {}) as Record<string, unknown>;
        if (typeof usage.input_tokens === "number") outcome.inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number") outcome.outputTokens = usage.output_tokens;
        break;
      }
      case "error":
        outcome.terminal = "error";
        outcome.isError = true;
        break;
      case "aborted":
        outcome.terminal = "aborted";
        break;
    }
  }
  return outcome;
}

export function createHttpClient(opts: HttpClientOptions): RuntimeClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const healthTimeoutMs = opts.healthTimeoutMs ?? 30_000;
  const turnTimeoutMs = opts.turnTimeoutMs ?? 120_000;

  async function health(): Promise<boolean> {
    const deadline = Date.now() + healthTimeoutMs;
    for (;;) {
      try {
        const res = await fetchImpl(`${baseUrl}/healthz`);
        if (res.ok) return true;
      } catch {
        // runtime not up yet
      }
      if (Date.now() >= deadline) return false;
      await sleep(1000);
    }
  }

  async function runTurn(input: { prompt: string; model?: string }): Promise<TurnOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), turnTimeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: input.prompt,
          ...(input.model ? { model: input.model } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`POST /sessions returned HTTP ${res.status}`);
      }
      return await reduceOutcome(res.body);
    } finally {
      clearTimeout(timer);
    }
  }

  return { health, runTurn };
}

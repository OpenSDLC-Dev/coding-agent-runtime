import { describe, expect, it } from "vitest";
import { parseSseBlock, readSse } from "./sse";

describe("parseSseBlock", () => {
  it("parses event + data + id", () => {
    expect(parseSseBlock('event: init\ndata: {"sessionId":"s1"}\nid: u1')).toEqual({
      event: "init",
      data: '{"sessionId":"s1"}',
      id: "u1",
    });
  });
  it("joins multi-line data and defaults event to message", () => {
    expect(parseSseBlock("data: a\ndata: b")).toEqual({ event: "message", data: "a\nb" });
  });
  it("returns null for comment/keepalive-only blocks", () => {
    expect(parseSseBlock(": keepalive")).toBeNull();
  });
});

describe("readSse", () => {
  it("yields events split on blank lines across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const chunks = ["event: init\ndata: 1\n\nev", "ent: result\ndata: 2\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const out: Array<{ event: string; data: string }> = [];
    for await (const e of readSse(stream)) out.push({ event: e.event, data: e.data });
    expect(out).toEqual([
      { event: "init", data: "1" },
      { event: "result", data: "2" },
    ]);
  });
});

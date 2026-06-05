import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startToolSpan, startTurnSpan, traceparentOf } from "../src/otel/spans.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

describe("otel/spans", () => {
  it("startTurnSpan creates a SERVER span carrying model + conversation id", () => {
    const span = startTurnSpan({ model: "MiniMax-M3", resumeId: "sess-1" });
    span.end();
    const [s] = exporter.getFinishedSpans();
    expect(s?.name).toBe("agent.turn");
    expect(s?.attributes["gen_ai.request.model"]).toBe("MiniMax-M3");
    expect(s?.attributes["gen_ai.conversation.id"]).toBe("sess-1");
  });

  it("traceparentOf serializes a valid W3C traceparent", () => {
    const span = startTurnSpan({});
    const tp = traceparentOf(span);
    span.end();
    const sc = span.spanContext();
    expect(tp).toBe(`00-${sc.traceId}-${sc.spanId}-01`);
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("startToolSpan nests the tool span under the turn span", () => {
    const turn = startTurnSpan({});
    const tool = startToolSpan(turn, { name: "Bash", id: "tu-1" });
    tool.end();
    turn.end();
    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.name === "tool:Bash");
    expect(toolSpan?.attributes["gen_ai.tool.name"]).toBe("Bash");
    expect(toolSpan?.attributes["gen_ai.tool.call.id"]).toBe("tu-1");
    // 父子关系：tool span 的 parent = turn span 的 spanId
    expect(toolSpan?.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
  });
});

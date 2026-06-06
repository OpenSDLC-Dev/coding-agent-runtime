import { context as otelContext, type Span, SpanKind, trace } from "@opentelemetry/api";
import { getTracer } from "../telemetry.js";

// Start the turn span (SpanKind.SERVER). On the first turn the sessionId is unknown, so only resume turns carry conversation.id up front;
// for the first turn, runTurn backfills it once the init event arrives.
export function startTurnSpan(attrs: { model?: string; resumeId?: string }): Span {
  return getTracer().startSpan("agent.turn", {
    kind: SpanKind.SERVER,
    attributes: {
      "gen_ai.operation.name": "chat",
      ...(attrs.model ? { "gen_ai.request.model": attrs.model } : {}),
      ...(attrs.resumeId ? { "gen_ai.conversation.id": attrs.resumeId } : {}),
    },
  });
}

// W3C traceparent: 00-<trace-id>-<span-id>-<flags>. Injected into the child CLI's env, combined with
// CLAUDE_CODE_PROPAGATE_TRACEPARENT=1 so the CLI's native spans attach under the turn span.
export function traceparentOf(span: Span): string {
  const sc = span.spanContext();
  const flags = (sc.traceFlags & 0x1).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

// Start a tool child span under the turn span (build the parent context explicitly from the turn span rather than relying on the active context).
export function startToolSpan(parent: Span, tool: { name: string; id: string }): Span {
  const ctx = trace.setSpan(otelContext.active(), parent);
  return getTracer().startSpan(
    `tool:${tool.name}`,
    { attributes: { "gen_ai.tool.name": tool.name, "gen_ai.tool.call.id": tool.id } },
    ctx,
  );
}

import { context as otelContext, type Span, SpanKind, trace } from "@opentelemetry/api";
import { getTracer } from "../telemetry.js";

// 开 turn span（SpanKind.SERVER）。首轮 sessionId 未知，仅 resume 轮先带 conversation.id；
// 首轮在 init 事件到达后由 runTurn 补设。
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

// W3C traceparent：00-<trace-id>-<span-id>-<flags>。注入子 CLI 的 env，配合
// CLAUDE_CODE_PROPAGATE_TRACEPARENT=1 让 CLI 原生 span 挂到 turn span 之下。
export function traceparentOf(span: Span): string {
  const sc = span.spanContext();
  const flags = (sc.traceFlags & 0x1).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

// 在 turn span 之下开 tool 子 span（显式以 turn span 构造父 context，不依赖 active context）。
export function startToolSpan(parent: Span, tool: { name: string; id: string }): Span {
  const ctx = trace.setSpan(otelContext.active(), parent);
  return getTracer().startSpan(
    `tool:${tool.name}`,
    { attributes: { "gen_ai.tool.name": tool.name, "gen_ai.tool.call.id": tool.id } },
    ctx,
  );
}

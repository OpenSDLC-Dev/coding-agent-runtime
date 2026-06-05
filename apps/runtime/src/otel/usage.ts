import type { Span } from "@opentelemetry/api";

// result 事件载荷里与用量相关的子集（来自 SDKResultMessage 经 mapMessage）。
export interface ResultUsageData {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
}

// 把本轮 token/费用打到 turn span（gen_ai.usage.*）。第三方端点 cost 可能失真（spec §7.3），
// 仅 token 可信；属性照打，解读由后端/看板负责。
export function setUsageAttributes(span: Span, d: ResultUsageData): void {
  const u = d.usage ?? {};
  if (u.input_tokens != null) span.setAttribute("gen_ai.usage.input_tokens", u.input_tokens);
  if (u.output_tokens != null) span.setAttribute("gen_ai.usage.output_tokens", u.output_tokens);
  if (u.cache_read_input_tokens != null)
    span.setAttribute("gen_ai.usage.cache_read_input_tokens", u.cache_read_input_tokens);
  if (u.cache_creation_input_tokens != null)
    span.setAttribute("gen_ai.usage.cache_creation_input_tokens", u.cache_creation_input_tokens);
  if (d.total_cost_usd != null) span.setAttribute("gen_ai.usage.cost_usd", d.total_cost_usd);
  if (d.num_turns != null) span.setAttribute("agent.turn.count", d.num_turns);
}

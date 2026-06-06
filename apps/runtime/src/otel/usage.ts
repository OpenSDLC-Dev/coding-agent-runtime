import type { Span } from "@opentelemetry/api";

// The usage-related subset of the result event payload (from SDKResultMessage via mapMessage).
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

// Emit this turn's tokens/cost onto the turn span (gen_ai.usage.*). Third-party endpoint cost may be inaccurate (spec §7.3),
// only tokens are trustworthy; emit the attributes anyway and leave interpretation to the backend/dashboard.
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

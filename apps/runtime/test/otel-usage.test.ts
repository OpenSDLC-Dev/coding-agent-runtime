import type { Span } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { setUsageAttributes } from "../src/otel/usage.js";

function fakeSpan() {
  const attrs: Record<string, unknown> = {};
  const span = {
    setAttribute(k: string, v: unknown) {
      attrs[k] = v;
      return this;
    },
  } as unknown as Span;
  return { span, attrs };
}

describe("otel/usage", () => {
  it("maps usage/cost/turns onto gen_ai.usage.* attributes", () => {
    const { span, attrs } = fakeSpan();
    setUsageAttributes(span, {
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      total_cost_usd: 0.01,
      num_turns: 2,
    });
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(20);
    expect(attrs["gen_ai.usage.cache_read_input_tokens"]).toBe(5);
    expect(attrs["gen_ai.usage.cost_usd"]).toBe(0.01);
    expect(attrs["agent.turn.count"]).toBe(2);
  });

  it("skips absent fields without throwing", () => {
    const { span, attrs } = fakeSpan();
    setUsageAttributes(span, {});
    expect(Object.keys(attrs)).toHaveLength(0);
  });
});

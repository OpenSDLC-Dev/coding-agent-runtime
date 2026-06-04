import { z } from "@hono/zod-openapi";

// OpenAPI 3.1 表达不了连续流；按 spec §4.3 只描述"单事件"载荷。
export const SseEventSchema = z
  .object({
    event: z.enum(["init", "assistant", "tool_result", "result", "error", "aborted"]),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("SseEvent");

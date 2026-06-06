import { z } from "@hono/zod-openapi";

// OpenAPI 3.1 cannot express a continuous stream; per spec §4.3 this only describes the "single event" payload.
export const SseEventSchema = z
  .object({
    event: z.enum(["init", "assistant", "tool_result", "result", "error", "aborted"]),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("SseEvent");

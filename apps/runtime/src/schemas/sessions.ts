import { z } from "@hono/zod-openapi";

export const StatusEnum = z.enum(["running", "idle", "error", "aborted"]);

// Opt-in structured-output request. The runtime forwards `schema` verbatim to the SDK; runtime
// validation lives in the route (envelope-only), this schema is for OpenAPI accuracy.
export const OutputFormat = z
  .object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.unknown()),
  })
  .openapi("OutputFormat");

// Multimodal content blocks (text + inline base64 image). An alternative to a plain `prompt`; runtime
// validation lives in the route, this schema is for OpenAPI accuracy.
export const ContentBlock = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      source: z.object({
        type: z.literal("base64"),
        media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        data: z.string(),
      }),
    }),
  ])
  .openapi("ContentBlock");

// Exactly one of `prompt` (string) or `content` (multimodal blocks) must be present.
const TurnInputShape = {
  prompt: z.string().min(1).optional(),
  content: z.array(ContentBlock).min(1).optional(),
  model: z.string().optional(),
  outputFormat: OutputFormat.optional(),
};
const exactlyOneInput = (b: { prompt?: string; content?: unknown[] }) =>
  (b.prompt !== undefined) !== (b.content !== undefined);

export const CreateSessionBody = z
  .object({
    ...TurnInputShape,
    prompt: TurnInputShape.prompt.openapi({ example: "Create a hello.txt in /workspace" }),
    model: TurnInputShape.model.openapi({ example: "MiniMax-M3" }),
  })
  .refine(exactlyOneInput, { message: "provide exactly one of prompt or content" })
  .openapi("CreateSessionBody");

export const TurnBody = z
  .object(TurnInputShape)
  .refine(exactlyOneInput, { message: "provide exactly one of prompt or content" })
  .openapi("TurnBody");

export const SessionListItem = z
  .object({
    id: z.string(),
    model: z.string().nullish(),
    status: StatusEnum,
    turns: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    totalCostUsd: z.number(),
    changedFiles: z.array(z.string()),
    createdAt: z.number(),
    lastActiveAt: z.number(),
  })
  .openapi("SessionListItem");

export const SessionInfo = SessionListItem.extend({
  summary: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
}).openapi("SessionInfo");

export const TranscriptMessage = z
  .object({
    type: z.enum(["user", "assistant", "system"]),
    uuid: z.string(),
    session_id: z.string(),
    message: z.unknown(),
    parent_tool_use_id: z.string().nullable(),
  })
  .openapi("TranscriptMessage");

export const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");
export const StopResponse = z.object({ stopped: z.boolean() }).openapi("StopResponse");
export const DeleteResponse = z.object({ deleted: z.boolean() }).openapi("DeleteResponse");

export const SessionIdParam = z
  .object({
    id: z.string().openapi({ param: { name: "id", in: "path" }, example: "0c1d…" }),
  })
  .openapi("SessionIdParam");

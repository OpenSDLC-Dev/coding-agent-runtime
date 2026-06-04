import { z } from "@hono/zod-openapi";

export const StatusEnum = z.enum(["running", "idle", "error", "aborted"]);

export const CreateSessionBody = z
  .object({
    prompt: z.string().min(1).openapi({ example: "在 /workspace 建一个 hello.txt" }),
    model: z.string().optional().openapi({ example: "MiniMax-M3" }),
  })
  .openapi("CreateSessionBody");

export const TurnBody = z
  .object({
    prompt: z.string().min(1),
    model: z.string().optional(),
  })
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

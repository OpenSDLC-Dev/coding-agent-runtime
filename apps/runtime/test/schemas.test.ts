import { describe, expect, it } from "vitest";
import { SseEventSchema } from "../src/schemas/events.js";
import {
  CreateSessionBody,
  ErrorResponse,
  SessionInfo,
  SessionListItem,
} from "../src/schemas/sessions.js";

describe("schemas", () => {
  it("CreateSessionBody requires a non-empty prompt", () => {
    expect(CreateSessionBody.safeParse({ prompt: "hi" }).success).toBe(true);
    expect(CreateSessionBody.safeParse({ prompt: "" }).success).toBe(false);
    expect(CreateSessionBody.safeParse({}).success).toBe(false);
    expect(CreateSessionBody.safeParse({ prompt: "hi", model: "MiniMax-M3" }).success).toBe(true);
  });

  it("SessionListItem accepts a registry record shape", () => {
    const ok = SessionListItem.safeParse({
      id: "s1",
      model: "MiniMax-M3",
      status: "idle",
      turns: 2,
      inputTokens: 10,
      outputTokens: 20,
      totalCostUsd: 0.03,
      changedFiles: ["/workspace/a.txt"],
      createdAt: 1,
      lastActiveAt: 2,
    });
    expect(ok.success).toBe(true);
  });

  it("SessionInfo extends list item with optional disk metadata", () => {
    const r = SessionInfo.safeParse({
      id: "s1",
      model: null,
      status: "running",
      turns: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      changedFiles: [],
      createdAt: 1,
      lastActiveAt: 1,
      summary: "first prompt",
      cwd: "/workspace",
    });
    expect(r.success).toBe(true);
  });

  it("ErrorResponse and SseEventSchema parse", () => {
    expect(ErrorResponse.safeParse({ error: "nope" }).success).toBe(true);
    expect(SseEventSchema.safeParse({ event: "init", data: { sessionId: "s1" } }).success).toBe(
      true,
    );
  });
});

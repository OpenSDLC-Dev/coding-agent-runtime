import { describe, expect, it } from "vitest";
import { runTurn } from "../src/agent/runtime.js";
import { fakeQueryFn, sampleMessages, testConfig } from "./helpers.js";

describe("runTurn", () => {
  it("maps SDK messages into ordered SSE events", async () => {
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(sampleMessages))) {
      events.push(e);
    }
    expect(events.map((e) => e.event)).toEqual(["init", "assistant", "tool_result", "result"]);
    expect(events[0]?.data).toMatchObject({ sessionId: "sess-1", model: "MiniMax-M3" });
    expect(events[1]?.data).toMatchObject({ text: "hello" });
    expect(events[3]?.data).toMatchObject({ sessionId: "sess-1", total_cost_usd: 0.01 });
  });

  it("captures tool_use blocks in the assistant event", async () => {
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(sampleMessages))) {
      events.push(e);
    }
    const asst = events.find((e) => e.event === "assistant");
    expect(asst?.data.toolUses).toEqual([{ id: "tu-1", name: "Bash", input: { command: "ls" } }]);
  });

  it("maps a result error subtype into an error event", async () => {
    const errMsgs = [
      {
        type: "system",
        subtype: "init",
        uuid: "i",
        session_id: "s",
        model: "m",
        cwd: "/workspace",
        tools: [],
      },
      {
        type: "result",
        subtype: "error_during_execution",
        uuid: "e",
        session_id: "s",
        is_error: true,
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        errors: ["boom"],
      },
    ] as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage[];
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(errMsgs))) {
      events.push(e);
    }
    const err = events.find((e) => e.event === "error");
    expect(err?.data).toMatchObject({ subtype: "error_during_execution", errors: ["boom"] });
  });
});

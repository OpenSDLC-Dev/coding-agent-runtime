import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../src/agent/config.js";
import type { QueryFn } from "../src/agent/runtime.js";

export const testConfig: RuntimeConfig = {
  anthropicApiKey: "sk-test",
  anthropicBaseUrl: undefined,
  defaultModel: "MiniMax-M3",
  includePartial: false,
  jaegerBaseUrl: undefined,
  port: 8080,
  cwd: "/workspace",
};

// 一个成功单轮的最小消息序列：init -> assistant(text + tool_use) -> user(tool_result) -> result(success)
export const sampleMessages: SDKMessage[] = [
  {
    type: "system",
    subtype: "init",
    uuid: "u-init",
    session_id: "sess-1",
    model: "MiniMax-M3",
    cwd: "/workspace",
    tools: ["Bash", "Read"],
  },
  {
    type: "assistant",
    uuid: "u-asst",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
  {
    type: "user",
    uuid: "u-user",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "a.txt", is_error: false }],
    },
  },
  {
    type: "result",
    subtype: "success",
    uuid: "u-result",
    session_id: "sess-1",
    is_error: false,
    num_turns: 1,
    duration_ms: 5,
    duration_api_ms: 4,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: {},
    result: "hello",
    permission_denials: [],
  },
] as unknown as SDKMessage[];

export function fakeQueryFn(messages: SDKMessage[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

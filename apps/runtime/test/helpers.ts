import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../src/agent/config.js";
import type { QueryFn } from "../src/agent/runtime.js";
import { DEFAULT_BASH_ALLOWLIST } from "../src/permissions/bash-allowlist.js";

export const testConfig: RuntimeConfig = {
  anthropicApiKey: "sk-test",
  anthropicBaseUrl: undefined,
  defaultModel: "MiniMax-M3",
  allowedModels: undefined,
  includePartial: false,
  jaegerBaseUrl: undefined,
  corsOrigins: "*",
  port: 8080,
  cwd: "/workspace",
  hostname: "127.0.0.1",
  claudeCliPath: undefined,
  effort: "max",
  bashAllowlist: [...DEFAULT_BASH_ALLOWLIST],
  heartbeatMs: 0,
  maxTurns: 0,
  turnTimeoutMs: 0,
  maxConcurrentTurns: 0,
  sessionTtlMs: 0,
  gcIntervalMs: 3_600_000,
  extensionsManifestPath: undefined,
};

// Minimal message sequence for a successful single turn: init -> assistant(text + tool_use) -> user(tool_result) -> result(success)
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

// Like fakeQueryFn, but records the Options it was called with so a test can assert
// what runTurn composed (e.g. that extension contributions reached the SDK).
export function recordingQueryFn(messages: SDKMessage[] = []): {
  queryFn: QueryFn;
  captured: () => Options | undefined;
} {
  let captured: Options | undefined;
  const queryFn: QueryFn = (args) => {
    captured = args.options;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { queryFn, captured: () => captured };
}

// Read an app.request SSE response into an array of event names plus the raw text, to make assertions easier.
export async function collectSse(res: Response): Promise<{ text: string; events: string[] }> {
  const text = await res.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1] as string);
  return { text, events };
}

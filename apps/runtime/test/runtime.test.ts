import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type QueryFn, runTurn } from "../src/agent/runtime.js";
import { fakeQueryFn, recordingQueryFn, sampleMessages, testConfig } from "./helpers.js";

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

  it("passes the P0 security backstop options to query", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, capturing)) {
      // drain
    }
    expect(captured?.permissionMode).toBe("bypassPermissions");
    expect(captured?.allowDangerouslySkipPermissions).toBe(true);
    expect(captured?.disallowedTools).toEqual(
      expect.arrayContaining(["Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)"]),
    );
  });

  it("passes the configured effort level through to query options", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, { ...testConfig, effort: "low" }, capturing)) {
      // drain
    }
    expect(captured?.effort).toBe("low");
  });

  it("passes a provided abortController through to query options", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    const ac = new AbortController();
    for await (const _e of runTurn({ prompt: "hi", abortController: ac }, testConfig, capturing)) {
      // drain
    }
    expect(captured?.abortController).toBe(ac);
  });

  it("sets pathToClaudeCodeExecutable to the decoupled CLI when configured", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn(
      { prompt: "hi" },
      { ...testConfig, claudeCliPath: "/usr/local/bin/claude" },
      capturing,
    )) {
      // drain
    }
    expect(captured?.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
  });

  it("leaves pathToClaudeCodeExecutable unset (SDK built-in CLI) when not configured", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, capturing)) {
      // drain
    }
    expect(captured?.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("passes maxTurns through to query options when configured (>0)", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, { ...testConfig, maxTurns: 42 }, capturing)) {
      // drain
    }
    expect(captured?.maxTurns).toBe(42);
  });

  it("omits maxTurns when set to 0 (unlimited)", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, { ...testConfig, maxTurns: 0 }, capturing)) {
      // drain
    }
    expect(captured?.maxTurns).toBeUndefined();
  });

  it("aborts the turn when the wall-clock timeout elapses", async () => {
    // hang after init until the turn's abortController fires (the timeout should fire it).
    const hang: QueryFn = (args) => {
      const signal = args.options.abortController?.signal;
      return (async function* () {
        yield sampleMessages[0] as never; // init (sess-1)
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })();
    };
    const ac = new AbortController();
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of runTurn(
          { prompt: "hi", abortController: ac },
          { ...testConfig, turnTimeoutMs: 5 },
          hang,
        )) {
          seen.push(e.event);
        }
      })(),
    ).rejects.toThrow();
    expect(ac.signal.aborted).toBe(true);
    expect(seen).toContain("init");
  });

  it("registers a PreToolUse Bash allowlist hook in query options", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, capturing)) {
      // drain
    }
    const matchers = captured?.hooks?.PreToolUse;
    expect(matchers).toHaveLength(1);
    expect(matchers?.[0]?.matcher).toBe("Bash");
    expect(matchers?.[0]?.hooks).toHaveLength(1);
  });

  it("threads extension contributions into query options without breaching the perimeter", async () => {
    const { queryFn, captured } = recordingQueryFn();
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, queryFn, {
      mcpServers: { demo: { type: "sdk", name: "demo" } as never },
      allowedTools: ["mcp__demo__ping"],
    })) {
      // drain
    }
    expect(captured()?.mcpServers?.demo).toBeDefined();
    expect(captured()?.allowedTools).toContain("mcp__demo__ping");
    // the security perimeter is untouched
    expect(captured()?.permissionMode).toBe("bypassPermissions");
    expect(captured()?.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(captured()?.disallowedTools).toEqual(
      expect.arrayContaining(["Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)"]),
    );
  });

  it("the registered hook denies a command outside the configured allowlist", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn(
      { prompt: "hi" },
      { ...testConfig, bashAllowlist: ["git"] },
      capturing,
    )) {
      // drain
    }
    const hook = captured?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    const out = await hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
        tool_use_id: "t",
        session_id: "s",
        transcript_path: "/t",
        cwd: "/workspace",
      } as never,
      "t",
      { signal: new AbortController().signal },
    );
    expect(
      (out as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput
        ?.permissionDecision,
    ).toBe("deny");
  });
});

describe("runTurn slash-command prompts", () => {
  // The runtime is prompt-agnostic: slash commands such as /loop and /goal are forwarded to the
  // agent verbatim — the runtime never intercepts, strips, or rewrites them. These pin that
  // contract so an SDK/CLI upgrade can't silently start mangling command prompts.
  const capturePrompt = async (prompt: string): Promise<string | undefined> => {
    let captured: string | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.prompt;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt }, testConfig, capturing)) {
      // drain
    }
    return captured;
  };

  it("forwards a /loop command prompt to query verbatim", async () => {
    const prompt = "/loop 5m /healthz keep checking the deploy";
    expect(await capturePrompt(prompt)).toBe(prompt);
  });

  it("forwards a /goal command prompt to query verbatim", async () => {
    const prompt = "/goal ship the feature and keep the tests green";
    expect(await capturePrompt(prompt)).toBe(prompt);
  });
});

describe("runTurn telemetry", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("emits a turn span with a nested tool span and usage attributes", async () => {
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, fakeQueryFn(sampleMessages))) {
      // drain
    }
    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "agent.turn");
    const tool = spans.find((s) => s.name === "tool:Bash");
    expect(turn).toBeDefined();
    expect(tool?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
    expect(turn?.attributes["gen_ai.conversation.id"]).toBe("sess-1");
    expect(turn?.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(turn?.attributes["gen_ai.usage.output_tokens"]).toBe(20);
  });

  it("adds traceId to init and result events and injects TRACEPARENT into child env", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {
        for (const m of sampleMessages) yield m;
      })();
    };
    const events = [];
    for await (const e of runTurn({ prompt: "hi" }, testConfig, capturing)) {
      events.push(e);
    }
    const init = events.find((e) => e.event === "init");
    const result = events.find((e) => e.event === "result");
    const traceId = init?.data.traceId as string;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(result?.data.traceId).toBe(traceId);
    // TRACEPARENT is injected into the child env, and its trace-id matches this turn
    expect(captured?.env?.TRACEPARENT).toContain(traceId);
  });
});

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import { isSpanContextValid, type Span, SpanStatusCode } from "@opentelemetry/api";
import { startToolSpan, startTurnSpan, traceparentOf } from "../otel/spans.js";
import { setUsageAttributes } from "../otel/usage.js";
import { createBashAllowlistHook } from "../permissions/bash-allowlist.js";
import type { RuntimeConfig } from "./config.js";

export type SseEventName = "init" | "assistant" | "tool_result" | "result" | "error" | "aborted";

export interface SseEvent {
  event: SseEventName;
  data: Record<string, unknown>;
  id?: string;
}

export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface RunTurnInput {
  prompt: string;
  model?: string;
  resumeId?: string;
  abortController?: AbortController;
}

// Normalize process.env (whose values may be undefined) into the Record<string,string> that query() expects, then layer on runtime overrides.
function buildChildEnv(cfg: RuntimeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  if (cfg.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = cfg.anthropicBaseUrl;
  env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? "/claude-config";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

function mapMessage(m: SDKMessage): SseEvent | null {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        return {
          event: "init",
          id: m.uuid,
          data: { sessionId: m.session_id, model: m.model, cwd: m.cwd, tools: m.tools },
        };
      }
      return null;
    case "assistant": {
      const text: string[] = [];
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      for (const block of m.message.content) {
        if (block.type === "text") {
          text.push(block.text);
        } else if (block.type === "tool_use") {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }
      return { event: "assistant", id: m.uuid, data: { text: text.join(""), toolUses } };
    }
    case "user": {
      const content = m.message.content;
      if (!Array.isArray(content)) return null;
      const results: Array<{ toolUseId: string; isError: boolean }> = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          results.push({ toolUseId: block.tool_use_id, isError: block.is_error ?? false });
        }
      }
      return results.length > 0 ? { event: "tool_result", data: { results } } : null;
    }
    case "result":
      if (m.subtype === "success") {
        return {
          event: "result",
          id: m.uuid,
          data: {
            sessionId: m.session_id,
            usage: m.usage,
            total_cost_usd: m.total_cost_usd,
            modelUsage: m.modelUsage,
            num_turns: m.num_turns,
            is_error: m.is_error,
          },
        };
      }
      return {
        event: "error",
        id: m.uuid,
        data: { subtype: m.subtype, errors: m.errors },
      };
    default:
      return null;
  }
}

export async function* runTurn(
  input: RunTurnInput,
  cfg: RuntimeConfig,
  queryFn: QueryFn = defaultQuery,
): AsyncGenerator<SseEvent> {
  const span = startTurnSpan({
    model: input.model ?? cfg.defaultModel,
    resumeId: input.resumeId,
  });
  const sc = span.spanContext();
  const traceId = isSpanContextValid(sc) ? sc.traceId : undefined;
  const toolSpans = new Map<string, Span>();

  const env = buildChildEnv(cfg);
  // Only inject TRACEPARENT when the span context is valid (a real TracerProvider has started), to avoid feeding the child CLI an all-zero id.
  if (traceId) env.TRACEPARENT = traceparentOf(span);

  const options: Options = {
    cwd: cfg.cwd,
    model: input.model ?? cfg.defaultModel,
    // Reasoning effort is maxed out by default (cfg.effort defaults to "max", adjustable via RUNTIME_EFFORT); see config.ts for details.
    effort: cfg.effort,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // P0 safety fallback: deny always wins, blocking network access / privilege escalation / dangerous deletes. This is a hard fallback that does not depend on file settings;
    // the full PreToolUse Bash allowlist (parsing && | ; splits, stripping wrappers) is still scheduled for P3 (spec §6).
    disallowedTools: ["Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)", "Bash(rm -rf:*)"],
    // P3 layer 1: parsing-based Bash allowlist (PreToolUse deny bypasses canUseTool, blocks even bypass mode, and covers sub-agents).
    // Layered on top of the disallowedTools fallback above: deny always wins.
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [createBashAllowlistHook(cfg.bashAllowlist)] }],
    },
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    includePartialMessages: cfg.includePartial,
    env,
    abortController: input.abortController,
    // SDK/CLI decoupling: points to the separately installed native Claude Code CLI binary (when set, the SDK spawns it directly,
    // over stdio/stream-json). When unset, the SDK falls back to its bundled platform binary.
    ...(cfg.claudeCliPath ? { pathToClaudeCodeExecutable: cfg.claudeCliPath } : {}),
    ...(input.resumeId ? { resume: input.resumeId } : {}),
  };

  try {
    for await (const m of queryFn({ prompt: input.prompt, options })) {
      const evt = mapMessage(m);
      if (!evt) continue;

      switch (evt.event) {
        case "init":
          span.setAttribute("gen_ai.conversation.id", String(evt.data.sessionId));
          break;
        case "assistant":
          for (const t of (evt.data.toolUses ?? []) as Array<{ id: string; name: string }>) {
            toolSpans.set(t.id, startToolSpan(span, { name: t.name, id: t.id }));
          }
          break;
        case "tool_result":
          for (const r of (evt.data.results ?? []) as Array<{
            toolUseId: string;
            isError: boolean;
          }>) {
            const ts = toolSpans.get(r.toolUseId);
            if (ts) {
              if (r.isError) ts.setStatus({ code: SpanStatusCode.ERROR });
              ts.end();
              toolSpans.delete(r.toolUseId);
            }
          }
          break;
        case "result":
          setUsageAttributes(span, evt.data);
          break;
        case "error":
          span.setStatus({ code: SpanStatusCode.ERROR });
          break;
      }

      if (traceId && (evt.event === "init" || evt.event === "result")) {
        evt.data = { ...evt.data, traceId };
      }
      yield evt;
    }
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    for (const ts of toolSpans.values()) ts.end(); // Close out any unpaired tool spans
    span.end();
  }
}

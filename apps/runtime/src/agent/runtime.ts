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

// 把 process.env（值可能 undefined）规整为 query() 需要的 Record<string,string>，再叠加运行时覆盖。
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
  // 仅当 span context 有效（已起真实 TracerProvider）才注入 TRACEPARENT，避免给子 CLI 喂全零 id。
  if (traceId) env.TRACEPARENT = traceparentOf(span);

  const options: Options = {
    cwd: cfg.cwd,
    model: input.model ?? cfg.defaultModel,
    // 推理强度默认拉满（cfg.effort 默认 "max"，可经 RUNTIME_EFFORT 调整）；详见 config.ts。
    effort: cfg.effort,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // P0 安全兜底：deny 永远赢，挡住联网/提权/危险删除。这是不依赖文件设置的硬兜底；
    // 完整的 PreToolUse Bash 白名单（解析 && | ; 拆分、剥包装器）仍排在 P3（spec §6）。
    disallowedTools: ["Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)", "Bash(rm -rf:*)"],
    // P3 第 1 层：解析式 Bash 白名单（PreToolUse deny 绕过 canUseTool、连 bypass 都拦、覆盖子 agent）。
    // 与上面的 disallowedTools 兜底叠加：deny 永远赢。
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [createBashAllowlistHook(cfg.bashAllowlist)] }],
    },
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    includePartialMessages: cfg.includePartial,
    env,
    abortController: input.abortController,
    // SDK/CLI 解耦：指向独立安装的 Claude Code CLI 原生二进制（设置时 SDK 直接 spawn 它，
    // 走 stdio/stream-json）。未设则 SDK 用自带平台二进制。
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
    for (const ts of toolSpans.values()) ts.end(); // 收尾未配对的 tool span
    span.end();
  }
}

import type { Message, ToolMessage } from "../types";

// One entry of the runtime's `tool_result` SSE event `data.results[]`.
export interface ToolResult {
  toolUseId?: string;
  isError?: boolean;
  content?: unknown;
}

// Normalize a tool_result content payload (string | content-block array | object) to display text.
export function formatToolResultContent(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

// Resolve the running tool message(s) addressed by a tool_result event, filling in each result.
// Match by toolUseId; fall back to the first still-running tool when the id is absent or unmatched
// (resilient to older runtimes that omit the per-result id). Returns the original array unchanged
// when nothing was resolved, so callers can skip a needless re-render.
export function applyToolResults(messages: Message[], results: ToolResult[]): Message[] {
  if (results.length === 0) return messages;
  let next: Message[] | null = null;
  for (const r of results) {
    const target = next ?? messages;
    let idx = -1;
    if (r.toolUseId) {
      idx = target.findIndex(
        (m) => m.kind === "tool" && m.toolUseId === r.toolUseId && m.status === "running",
      );
    }
    if (idx === -1) {
      idx = target.findIndex((m) => m.kind === "tool" && m.status === "running");
    }
    if (idx === -1) continue;
    if (!next) next = messages.slice();
    next[idx] = {
      ...(next[idx] as ToolMessage),
      status: "done",
      result: formatToolResultContent(r.content),
    };
  }
  return next ?? messages;
}

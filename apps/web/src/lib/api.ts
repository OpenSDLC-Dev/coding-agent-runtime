import type { ContentBlock } from "./content";
import { readSse, type SseEvent } from "./sse";

export interface RuntimeConfigDto {
  defaultModel: string | null;
  allowedModels: string[] | null;
  jaegerBaseUrl: string | null;
  version: string;
  includePartial: boolean;
}

export async function getHealth(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function getConfig(base: string): Promise<RuntimeConfigDto> {
  const res = await fetch(`${base}/config`);
  if (!res.ok) throw new Error(`config failed: ${res.status}`);
  return (await res.json()) as RuntimeConfigDto;
}

export async function* streamTurn(
  base: string,
  opts: { sessionId?: string; prompt?: string; content?: ContentBlock[]; model?: string },
): AsyncGenerator<SseEvent> {
  const url = opts.sessionId ? `${base}/sessions/${opts.sessionId}/turns` : `${base}/sessions`;
  // Send multimodal `content` when present (mutually exclusive with `prompt` on the runtime), else the string prompt.
  const body = opts.content
    ? { content: opts.content, model: opts.model }
    : { prompt: opts.prompt, model: opts.model };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`turn failed: ${res.status}`);
  yield* readSse(res.body);
}

export async function stopSession(base: string, id: string): Promise<void> {
  await fetch(`${base}/sessions/${id}/stop`, { method: "POST" });
}

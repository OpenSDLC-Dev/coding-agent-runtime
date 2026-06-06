import { useState } from "react";
import { stopSession, streamTurn } from "../lib/api";
import { traceUrl } from "../lib/trace";

interface Line {
  kind: "user" | "assistant" | "tool" | "result" | "error" | "system";
  text: string;
}

interface Props {
  baseUrl: string;
  model: string | undefined;
  jaegerBaseUrl: string | null;
}

export function ChatPanel({ baseUrl, model, jaegerBaseUrl }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [lastTraceId, setLastTraceId] = useState<string | undefined>(undefined);

  function push(line: Line) {
    setLines((prev) => [...prev, line]);
  }

  async function send() {
    if (!prompt.trim() || busy) return;
    const text = prompt;
    setPrompt("");
    push({ kind: "user", text });
    setBusy(true);
    try {
      for await (const evt of streamTurn(baseUrl, { sessionId, prompt: text, model })) {
        const data = JSON.parse(evt.data) as Record<string, unknown>;
        if (evt.event === "init") {
          setSessionId(String(data.sessionId));
          if (data.traceId) setLastTraceId(String(data.traceId));
          push({ kind: "system", text: `session ${data.sessionId} · model ${data.model ?? ""}` });
        } else if (evt.event === "assistant") {
          if (data.text) push({ kind: "assistant", text: String(data.text) });
          const toolUses = (data.toolUses ?? []) as Array<{ name: string; input: unknown }>;
          for (const t of toolUses)
            push({ kind: "tool", text: `→ ${t.name} ${JSON.stringify(t.input)}` });
        } else if (evt.event === "tool_result") {
          push({ kind: "tool", text: `✓ tool_result` });
        } else if (evt.event === "result") {
          const u = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          push({
            kind: "result",
            text: `done · turns ${data.num_turns} · in ${u?.input_tokens ?? 0} out ${u?.output_tokens ?? 0} · $${data.total_cost_usd ?? 0}`,
          });
          if (data.traceId) setLastTraceId(String(data.traceId));
        } else if (evt.event === "error" || evt.event === "aborted") {
          push({ kind: "error", text: `${evt.event}: ${evt.data}` });
        }
      }
    } catch (err) {
      push({ kind: "error", text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: conversation log is append-only
          <div key={i} className={`line line-${l.kind}`}>
            {l.text}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Instructions for the agent…"
          aria-label="prompt"
        />
        <div className="chat-actions">
          <button type="button" onClick={send} disabled={busy}>
            {sessionId ? "Send next turn" : "Send"}
          </button>
          <button
            type="button"
            onClick={() => sessionId && stopSession(baseUrl, sessionId)}
            disabled={!busy || !sessionId}
          >
            Stop
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionId(undefined);
              setLines([]);
            }}
            disabled={busy}
          >
            New session
          </button>
          <span className="sid">{sessionId ? `Session ${sessionId}` : "Not started"}</span>
          {(() => {
            const url = traceUrl(jaegerBaseUrl, lastTraceId);
            return url ? (
              <a className="trace-link" href={url} target="_blank" rel="noreferrer">
                Open trace in Jaeger
              </a>
            ) : null;
          })()}
        </div>
      </div>
    </div>
  );
}

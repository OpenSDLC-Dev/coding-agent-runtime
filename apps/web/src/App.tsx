import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { MessageStream } from "./components/MessageStream";
import { Sidebar } from "./components/Sidebar";
import { SpecPanel } from "./components/SpecPanel";
import { type ConnState, Topbar } from "./components/Topbar";
import { getConfig, getHealth, type RuntimeConfigDto, stopSession, streamTurn } from "./lib/api";
import { buildContentBlocks, type ContentBlock, type ImageAttachment } from "./lib/content";
import { uid } from "./lib/format";
import { applyToolResults, type ToolResult } from "./lib/tool-result";
import type {
  AssistantMessage,
  ChangedFile,
  Message,
  ResultMessage,
  Session,
  SessionStatus,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from "./types";
import { Badge, type BadgeVariant, Button } from "./ui/primitives";

const DEFAULT_BASE_URL = "http://localhost:8080";

const STATUS_BADGE: Record<SessionStatus, BadgeVariant> = {
  running: "success",
  idle: "neutral",
  stopped: "warning",
  error: "error",
};
const STATUS_TEXT: Record<SessionStatus, string> = {
  running: "Running",
  idle: "Idle",
  stopped: "Stopped",
  error: "Error",
};

// --- message factories (keep the discriminated union tidy) ---
const mkUser = (text: string, images?: string[]): UserMessage => ({
  id: uid(),
  kind: "user",
  text,
  ...(images && images.length > 0 ? { images } : {}),
});
const mkAssistant = (text: string): AssistantMessage => ({ id: uid(), kind: "assistant", text });
const mkTool = (
  name: string,
  input: Record<string, unknown> | null,
  toolUseId?: string,
): ToolMessage => ({
  id: uid(),
  kind: "tool",
  name,
  input,
  status: "running",
  result: null,
  toolUseId,
});
const mkSystem = (text: string, error?: boolean): SystemMessage => ({
  id: uid(),
  kind: "system",
  text,
  error,
});
const mkResult = (
  turns: number,
  tokensIn: number,
  tokensOut: number,
  cost: number,
): ResultMessage => ({
  id: uid(),
  kind: "result",
  turns,
  tokensIn,
  tokensOut,
  cost,
});

function newSession(model: string): Session {
  return {
    id: `se_${uid()}`,
    title: "New session",
    status: "idle",
    model,
    created: "just now",
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    traceId: null,
    changedFiles: [],
    messages: [],
  };
}

function extractFiles(data: Record<string, unknown>): ChangedFile[] {
  const raw = data.changedFiles ?? data.files;
  if (!Array.isArray(raw)) return [];
  const out: ChangedFile[] = [];
  for (const f of raw) {
    if (typeof f === "string") {
      out.push({ path: f, action: "edited" });
    } else if (f && typeof f === "object") {
      const rec = f as Record<string, unknown>;
      const path = typeof rec.path === "string" ? rec.path : "";
      const action = typeof rec.action === "string" ? rec.action : "edited";
      if (path) out.push({ path, action });
    }
  }
  return out;
}

function mergeFiles(existing: ChangedFile[], incoming: ChangedFile[]): ChangedFile[] {
  const map = new Map(existing.map((f) => [f.path, f]));
  for (const f of incoming) if (!map.has(f.path)) map.set(f.path, f);
  return [...map.values()];
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>(() => [newSession("")]);
  const [activeId, setActiveId] = useState(() => sessions[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [cfg, setCfg] = useState<RuntimeConfigDto | null>(null);
  const [model, setModel] = useState("");
  const [view, setView] = useState<"chat" | "spec">("chat");

  const runnerRef = useRef<{ cancelled: boolean } | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // sessions is never empty (create/delete keep ≥1); the final fallback only
  // satisfies the type checker under noUncheckedIndexedAccess.
  const active: Session =
    sessions.find((s) => s.id === activeId) ?? sessions[0] ?? newSession(model);

  const updateActive = useCallback((fn: (s: Session) => Session) => {
    const id = activeIdRef.current;
    setSessions((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  // ---- connection ----
  const connect = useCallback(async (url: string) => {
    setConn("connecting");
    const healthy = await getHealth(url);
    if (!healthy) {
      setConn("fail");
      return;
    }
    try {
      const c = await getConfig(url);
      setCfg(c);
      setConn("ok");
      const dm = c.defaultModel ?? "";
      if (dm) {
        setModel((m) => m || dm);
        setSessions((prev) =>
          prev.map((s) => (s.messages.length === 0 ? { ...s, model: s.model || dm } : s)),
        );
      }
    } catch {
      setConn("fail");
    }
  }, []);

  useEffect(() => {
    void connect(DEFAULT_BASE_URL);
  }, [connect]);

  function reconnect(url: string) {
    setBaseUrl(url);
    void connect(url);
  }

  // ---- session management ----
  function selectSession(id: string) {
    if (busy) return;
    setActiveId(id);
    setView("chat");
  }
  function createSession() {
    if (busy) return;
    const s = newSession(model);
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setView("chat");
  }
  function deleteSession(id: string) {
    if (busy) return;
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (next.length === 0) {
        const s = newSession(model);
        setActiveId(s.id);
        return [s];
      }
      const first = next[0];
      if (id === activeIdRef.current && first) setActiveId(first.id);
      return next;
    });
  }

  // ---- stream a turn against the live runtime ----
  async function runTurn(
    prompt: string,
    content: ContentBlock[] | undefined,
    priorRealId: string | undefined,
    runner: { cancelled: boolean },
    isFirst: boolean,
  ) {
    let endedWith: "result" | "aborted" | "error" | null = null;
    try {
      for await (const evt of streamTurn(baseUrl, {
        sessionId: priorRealId,
        prompt: content ? undefined : prompt,
        content,
        model: model || undefined,
      })) {
        if (runner.cancelled) break;
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(evt.data) as Record<string, unknown>;
        } catch {
          // non-JSON payload (e.g. plain error text) — keep an empty object
        }

        if (evt.event === "init") {
          const sid = data.sessionId != null ? String(data.sessionId) : undefined;
          const tid = data.traceId != null ? String(data.traceId) : null;
          const mdl = data.model != null ? String(data.model) : model;
          updateActive((s) => ({
            ...s,
            realId: sid ?? s.realId,
            traceId: tid ?? s.traceId,
            messages: isFirst
              ? [...s.messages, mkSystem(`session ${sid ?? s.id} started · model ${mdl}`)]
              : s.messages,
          }));
        } else if (evt.event === "assistant") {
          if (typeof data.text === "string" && data.text.length > 0) {
            const text = data.text;
            updateActive((s) => ({ ...s, messages: [...s.messages, mkAssistant(text)] }));
          }
          const toolUses = Array.isArray(data.toolUses)
            ? (data.toolUses as Array<{ id?: unknown; name?: unknown; input?: unknown }>)
            : [];
          for (const t of toolUses) {
            const name = typeof t.name === "string" ? t.name : "tool";
            const input =
              t.input && typeof t.input === "object" ? (t.input as Record<string, unknown>) : null;
            const toolUseId = typeof t.id === "string" ? t.id : undefined;
            updateActive((s) => ({
              ...s,
              messages: [...s.messages, mkTool(name, input, toolUseId)],
            }));
          }
        } else if (evt.event === "tool_result") {
          const results = Array.isArray(data.results) ? (data.results as ToolResult[]) : [];
          updateActive((s) => ({ ...s, messages: applyToolResults(s.messages, results) }));
        } else if (evt.event === "result") {
          endedWith = "result";
          const usage = (data.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
          const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
          const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
          const cost =
            typeof data.total_cost_usd === "number"
              ? data.total_cost_usd
              : Number(data.total_cost_usd ?? 0) || 0;
          const tid = data.traceId != null ? String(data.traceId) : null;
          const files = extractFiles(data);
          updateActive((s) => ({
            ...s,
            messages: [...s.messages, mkResult(s.turns + 1, inTok, outTok, cost)],
            turns: s.turns + 1,
            tokensIn: s.tokensIn + inTok,
            tokensOut: s.tokensOut + outTok,
            cost: +(s.cost + cost).toFixed(4),
            traceId: tid ?? s.traceId,
            changedFiles: mergeFiles(s.changedFiles, files),
          }));
        } else if (evt.event === "error") {
          endedWith = "error";
          updateActive((s) => ({
            ...s,
            status: "error",
            messages: [...s.messages, mkSystem(`error: ${evt.data}`, true)],
          }));
        } else if (evt.event === "aborted") {
          endedWith = "aborted";
          updateActive((s) => ({
            ...s,
            status: "stopped",
            messages: [...s.messages, mkSystem("— turn aborted —")],
          }));
        }
      }
    } catch (err) {
      endedWith = "error";
      const msg = err instanceof Error ? err.message : String(err);
      updateActive((s) => ({
        ...s,
        status: "error",
        messages: [...s.messages, mkSystem(`error: ${msg}`, true)],
      }));
    } finally {
      finalizeTurn(runner, endedWith);
      setBusy(false);
      runnerRef.current = null;
    }
  }

  function finalizeTurn(
    runner: { cancelled: boolean },
    endedWith: "result" | "aborted" | "error" | null,
  ) {
    updateActive((s) => {
      let status: SessionStatus;
      let messages: Message[] = s.messages;
      if (runner.cancelled && endedWith !== "aborted") {
        messages = [...messages, mkSystem("— turn aborted —")];
        status = "stopped";
      } else if (endedWith === "error") {
        status = "error";
      } else if (endedWith === "aborted") {
        status = "stopped";
      } else {
        status = "idle";
      }
      return { ...s, status, messages };
    });
  }

  function send(prompt: string, images: ImageAttachment[] = []) {
    if (busy) return;
    const isFirst = active.messages.length === 0;
    // With images, drive a multimodal `content` turn; otherwise the plain string prompt path is unchanged.
    const content = images.length > 0 ? buildContentBlocks(prompt, images) : undefined;
    const dataUrls = images.map((i) => i.dataUrl);
    const title = prompt.trim() || (images.length > 0 ? `${images.length} image(s)` : "");
    updateActive((s) => ({
      ...s,
      title: isFirst ? title.slice(0, 70) : s.title,
      created: isFirst ? "just now" : s.created,
      model: isFirst ? model || s.model : s.model,
      status: "running",
      messages: [...s.messages, mkUser(prompt, dataUrls)],
    }));
    setBusy(true);
    const runner = { cancelled: false };
    runnerRef.current = runner;
    void runTurn(prompt, content, active.realId, runner, isFirst);
  }

  function stop() {
    const r = runnerRef.current;
    if (r) r.cancelled = true;
    const id = active.realId;
    if (id) void stopSession(baseUrl, id).catch(() => {});
  }

  // ---- derived ----
  const models = (() => {
    const list = cfg?.allowedModels?.length ? [...cfg.allowedModels] : [];
    if (cfg?.defaultModel && !list.includes(cfg.defaultModel)) list.unshift(cfg.defaultModel);
    if (model && !list.includes(model)) list.unshift(model);
    return list.length ? list : [model];
  })();
  const usage = {
    tokensIn: active.tokensIn,
    tokensOut: active.tokensOut,
    cost: active.cost,
    turns: active.turns,
  };

  return (
    <div className="app">
      <Topbar
        conn={conn}
        baseUrl={baseUrl}
        onReconnect={reconnect}
        model={model}
        models={models}
        onModel={setModel}
        usage={usage}
        version={cfg?.version ?? null}
        specOpen={view === "spec"}
        onToggleSpec={() => setView((v) => (v === "spec" ? "chat" : "spec"))}
      />
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={selectSession}
        onNew={createSession}
      />

      <main className="main chat-main">
        {view === "spec" ? (
          <>
            <div className="chat-header">
              <div className="ch-title">
                <h1>API reference</h1>
                <div className="ch-sub">OpenAPI 3.1 · Swagger UI</div>
              </div>
              <div className="ch-actions">
                <Button variant="secondary" onClick={() => setView("chat")}>
                  Back to chat
                </Button>
              </div>
            </div>
            <SpecPanel baseUrl={baseUrl} />
          </>
        ) : (
          <>
            <div className="chat-header">
              <div className="ch-title">
                <h1>{active.title}</h1>
                <div className="ch-sub">
                  <Badge variant={STATUS_BADGE[active.status]} dot>
                    {STATUS_TEXT[active.status]}
                  </Badge>
                  <span className="mono">{active.realId ?? active.id}</span>
                  <span>·</span>
                  <span className="mono">{active.model || "—"}</span>
                </div>
              </div>
              <div className="ch-actions">
                {busy ? (
                  <Button variant="destructive" icon="close" onClick={stop}>
                    Stop turn
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  icon="delete"
                  onClick={() => deleteSession(active.id)}
                  disabled={busy}
                >
                  Delete
                </Button>
              </div>
            </div>

            {active.messages.length === 0 ? (
              <EmptyState onPick={send} />
            ) : (
              <MessageStream session={active} jaegerBaseUrl={cfg?.jaegerBaseUrl ?? null} />
            )}

            <Composer
              busy={busy}
              isFollowUp={active.messages.length > 0}
              onSend={send}
              onStop={stop}
            />
          </>
        )}
      </main>
    </div>
  );
}

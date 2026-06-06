// Chat surface: user/agent bubbles, collapsible tool cards, per-turn result
// rows (token/cost stats + Jaeger trace link), and a changed-files rail.
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { TOOL_ICON } from "../lib/suggestions";
import { traceUrl } from "../lib/trace";
import type { AssistantMessage, ResultMessage, Session, ToolMessage, UserMessage } from "../types";
import { Icon } from "../ui/icons";

// Render inline `code` spans from backticks.
function richText(text: string): ReactNode[] {
  return String(text)
    .split(/(`[^`]+`)/g)
    .map((p, i) =>
      p.startsWith("`") && p.endsWith("`") ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: static split of an immutable string
        <code key={i}>{p.slice(1, -1)}</code>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: static split of an immutable string
        <Fragment key={i}>{p}</Fragment>
      ),
    );
}

function AgentAvatar() {
  return (
    <span className="avatar-sq agent">
      <Icon name="robot" />
    </span>
  );
}

function Bubble({ m, live }: { m: UserMessage | AssistantMessage; live?: boolean }) {
  const isUser = m.kind === "user";
  return (
    <div className={`msg-row ${isUser ? "user" : "assistant"}`}>
      {isUser ? <span className="avatar-sq user">DV</span> : <AgentAvatar />}
      <div className={`bubble ${isUser ? "user" : "assistant"}`}>
        {richText(m.text)}
        {live ? <span className="cursor" /> : null}
      </div>
    </div>
  );
}

function inputSummary(input: Record<string, unknown> | null): string {
  if (!input) return "";
  const v =
    input.file_path ??
    input.path ??
    input.pattern ??
    (typeof input.command === "string" ? input.command.split(" ")[0] : undefined);
  return typeof v === "string" ? v : "";
}

function fmtInput(input: Record<string, unknown> | null): string {
  if (!input) return "";
  if (typeof input.command === "string") return input.command;
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

function ToolCard({ m }: { m: ToolMessage }) {
  const [open, setOpen] = useState(false);
  const running = m.status === "running";
  const icon = TOOL_ICON[m.name] ?? "send";
  return (
    <div className="msg-row assistant">
      <AgentAvatar />
      <div className="tool-card">
        <button
          type="button"
          className="tc-head"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tc-icon">
            <Icon name={icon} />
          </span>
          <span className="tc-name">
            {m.name}
            <span className="mono">{inputSummary(m.input)}</span>
          </span>
          {running ? (
            <span className="tc-status">
              <span className="spinner" />
              Running
            </span>
          ) : (
            <span className="tc-status done">
              <Icon name="checkmark-circle" />
              Done
            </span>
          )}
          <span className={`tc-chev ${open ? "open" : ""}`}>
            <Icon name="chevron-disclosure" />
          </span>
        </button>
        {open ? (
          <div className="tc-body">
            <div className="tc-section">
              <div className="tc-label">Input</div>
              <div className="tc-code">{fmtInput(m.input)}</div>
            </div>
            {!running && m.result ? (
              <div className="tc-section">
                <div className="tc-label">Result</div>
                <div className="tc-code">{m.result}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ResultRow({
  m,
  jaegerBaseUrl,
  traceId,
}: {
  m: ResultMessage;
  jaegerBaseUrl: string | null;
  traceId: string | undefined;
}) {
  const url = traceUrl(jaegerBaseUrl, traceId);
  return (
    <div className="msg-row assistant">
      <span style={{ width: 30, flex: "0 0 30px" }} />
      <div className="result-row">
        <Icon name="checkmark-circle" className="ic ic-ok" />
        <div className="rr-stats">
          <span className="rr-stat">
            Turn complete · <b>{m.turns}</b> turn{m.turns === 1 ? "" : "s"}
          </span>
          <span className="rr-stat">
            in <b>{m.tokensIn.toLocaleString()}</b>
          </span>
          <span className="rr-stat">
            out <b>{m.tokensOut.toLocaleString()}</b>
          </span>
          <span className="rr-stat">
            cost <b>${m.cost.toFixed(4)}</b>
          </span>
        </div>
        {url ? (
          <a className="trace" href={url} target="_blank" rel="noreferrer">
            <Icon name="link-external" />
            Open trace in Jaeger
          </a>
        ) : null}
      </div>
    </div>
  );
}

function ChangedFiles({ session }: { session: Session }) {
  const files = session.changedFiles;
  if (!files || files.length === 0) return null;
  return (
    <div className="chat-inner">
      <div className="files-rail">
        <div className="fr-head">
          <Icon name="edit" style={{ width: 13, height: 13, display: "inline-flex" }} />
          Changed files · {files.length}
        </div>
        {files.map((f) => (
          <div className="fr-item" key={`${f.action}:${f.path}`}>
            <span className={`tag ${f.action}`}>{f.action}</span>
            {f.path}
          </div>
        ))}
      </div>
    </div>
  );
}

interface MessageStreamProps {
  session: Session;
  jaegerBaseUrl: string | null;
}

export function MessageStream({ session, jaegerBaseUrl }: MessageStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = session.messages;
  const last = messages[messages.length - 1];
  const lastText = last && "text" in last ? last.text : "";

  // Keep the newest content in view as the turn streams. The deps are
  // intentional re-scroll triggers (the effect itself only reads the ref).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are scroll triggers, not used inside the effect
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.id, messages.length, lastText, session.status]);

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat-inner">
        {messages.map((m) => {
          if (m.kind === "user" || m.kind === "assistant") {
            const live =
              session.status === "running" && m.id === last?.id && m.kind === "assistant";
            return <Bubble key={m.id} m={m} live={live} />;
          }
          if (m.kind === "tool") return <ToolCard key={m.id} m={m} />;
          if (m.kind === "result")
            return (
              <ResultRow
                key={m.id}
                m={m}
                jaegerBaseUrl={jaegerBaseUrl}
                traceId={session.traceId ?? undefined}
              />
            );
          return (
            <div className={`sys-line ${m.error ? "error" : ""}`} key={m.id}>
              {m.text}
            </div>
          );
        })}
      </div>
      {session.status !== "running" ? <ChangedFiles session={session} /> : null}
    </div>
  );
}

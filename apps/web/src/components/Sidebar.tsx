// Sessions sidebar: a primary "New session" action and a list of client-side
// sessions with live status dots, turn/token/cost meta.
import { fmtTokens } from "../lib/format";
import type { Session, SessionStatus } from "../types";
import { Button } from "../ui/primitives";

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Running",
  idle: "Idle",
  stopped: "Stopped",
  error: "Error",
};

function SessionItem({ s, active, onClick }: { s: Session; active: boolean; onClick: () => void }) {
  return (
    <button className={`session-item ${active ? "active" : ""}`} onClick={onClick} type="button">
      <div className="si-top">
        <span className={`si-dot ${s.status}`} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--color-text-weak)",
            textTransform: "capitalize",
          }}
        >
          {STATUS_LABEL[s.status]}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-weaker)" }}>
          {s.created}
        </span>
      </div>
      <div className="si-title">{s.title}</div>
      <div className="si-meta">
        <span>
          {s.turns} turn{s.turns === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span className="mono">{fmtTokens(s.tokensIn + s.tokensOut)} tok</span>
        <span>·</span>
        <span className="mono">${s.cost.toFixed(4)}</span>
      </div>
    </button>
  );
}

interface SidebarProps {
  sessions: Session[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function Sidebar({ sessions, activeId, onSelect, onNew }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="side-head">
        <h2>Sessions</h2>
        <span className="count">{sessions.length}</span>
      </div>
      <div className="new-session">
        <Button variant="primary" icon="plus" onClick={onNew}>
          New session
        </Button>
      </div>
      <div className="session-list">
        {sessions.map((s) => (
          <SessionItem key={s.id} s={s} active={s.id === activeId} onClick={() => onSelect(s.id)} />
        ))}
      </div>
    </aside>
  );
}

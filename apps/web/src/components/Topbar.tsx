// Dark Console top bar: robot brand mark, editable runtime URL with live
// connection dot, model picker, live usage meter, and an API-docs toggle.
import { useEffect, useState } from "react";
import { fmtCost, fmtTokens } from "../lib/format";
import { Icon } from "../ui/icons";

export type ConnState = "ok" | "connecting" | "fail";

interface Usage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  turns: number;
}

interface TopbarProps {
  conn: ConnState;
  baseUrl: string;
  onReconnect: (url: string) => void;
  model: string;
  models: string[];
  onModel: (m: string) => void;
  usage: Usage;
  version: string | null;
  specOpen: boolean;
  onToggleSpec: () => void;
}

const CONN_LABEL: Record<ConnState, string> = {
  ok: "Connected",
  connecting: "Connecting…",
  fail: "Unreachable",
};

export function Topbar({
  conn,
  baseUrl,
  onReconnect,
  model,
  models,
  onModel,
  usage,
  version,
  specOpen,
  onToggleSpec,
}: TopbarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(baseUrl);
  useEffect(() => setDraft(baseUrl), [baseUrl]);

  const commit = () => {
    setEditing(false);
    onReconnect(draft);
  };

  return (
    <div className="topbar">
      <div className="logo">
        <span className="mark">
          <Icon name="robot" style={{ width: "100%", height: "100%" }} />
        </span>
        <span className="product">
          Coding Agent Runtime
          <span className="sub">Playground</span>
        </span>
      </div>

      {editing ? (
        <div className="conn" title="Runtime base URL">
          <span className={`conn-dot ${conn}`} />
          <input
            value={draft}
            // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened
            autoFocus
            aria-label="runtime base url"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
          <span className="conn-label">
            · {CONN_LABEL[conn]}
            {conn === "ok" && version ? ` · v${version}` : ""}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="conn"
          title="Edit runtime base URL"
          onClick={() => setEditing(true)}
        >
          <span className={`conn-dot ${conn}`} />
          <span className="conn-url">{baseUrl}</span>
          <span className="conn-label">
            · {CONN_LABEL[conn]}
            {conn === "ok" && version ? ` · v${version}` : ""}
          </span>
        </button>
      )}

      <div className="model-pick" title="Model">
        <Icon name="chevron-disclosure" />
        <select value={model} onChange={(e) => onModel(e.target.value)} aria-label="model">
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="right">
        <div className="usage-meter" title="Active session usage">
          <div className="um">
            <span className="k">Tokens</span>
            <span className="v">{fmtTokens(usage.tokensIn + usage.tokensOut)}</span>
          </div>
          <span className="sep" />
          <div className="um">
            <span className="k">Cost</span>
            <span className="v">{fmtCost(usage.cost)}</span>
          </div>
          <span className="sep" />
          <div className="um">
            <span className="k">Turns</span>
            <span className="v">{usage.turns}</span>
          </div>
        </div>
        <button
          type="button"
          className={`iconbtn${specOpen ? " active" : ""}`}
          title="API docs"
          onClick={onToggleSpec}
        >
          <Icon name="information" />
        </button>
        <span className="avatar" style={{ background: "var(--palette-blue-60)" }}>
          DV
        </span>
      </div>
    </div>
  );
}

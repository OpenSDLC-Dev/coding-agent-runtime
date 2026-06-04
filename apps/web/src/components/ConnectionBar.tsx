import { useState } from "react";
import { getConfig, getHealth, type RuntimeConfigDto } from "../lib/api";

interface Props {
  baseUrl: string;
  // 成功时上抛最终编辑后的 baseUrl + config（App.tsx 据此记下当前 baseUrl）。
  onConnected: (baseUrl: string, cfg: RuntimeConfigDto) => void;
}

export function ConnectionBar({ baseUrl: initial, onConnected }: Props) {
  const [baseUrl, setBaseUrl] = useState(initial);
  const [status, setStatus] = useState<"idle" | "connecting" | "ok" | "fail">("idle");

  async function connect() {
    setStatus("connecting");
    const healthy = await getHealth(baseUrl);
    if (!healthy) {
      setStatus("fail");
      return;
    }
    try {
      const cfg = await getConfig(baseUrl);
      setStatus("ok");
      onConnected(baseUrl, cfg);
    } catch {
      setStatus("fail");
    }
  }

  return (
    <div className="connbar">
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="http://localhost:8080"
        aria-label="runtime base url"
      />
      <button type="button" onClick={connect}>
        连接
      </button>
      <span className={`status status-${status}`}>{status}</span>
    </div>
  );
}

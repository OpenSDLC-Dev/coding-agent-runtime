import { useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { ConnectionBar } from "./components/ConnectionBar";
import { SpecPanel } from "./components/SpecPanel";
import type { RuntimeConfigDto } from "./lib/api";

export function App() {
  const [baseUrl, setBaseUrl] = useState("http://localhost:8080");
  const [cfg, setCfg] = useState<RuntimeConfigDto | null>(null);
  const [tab, setTab] = useState<"chat" | "spec">("chat");
  const [model, setModel] = useState<string | undefined>(undefined);

  return (
    <main className="app">
      <h1>Coding Agent Runtime — Playground</h1>
      <ConnectionBar
        baseUrl={baseUrl}
        onConnected={(url, c) => {
          setBaseUrl(url);
          setCfg(c);
          setModel(c.defaultModel ?? undefined);
        }}
      />
      {cfg && (
        <>
          <div className="toolbar">
            <button type="button" onClick={() => setTab("chat")} disabled={tab === "chat"}>
              对话
            </button>
            <button type="button" onClick={() => setTab("spec")} disabled={tab === "spec"}>
              spec
            </button>
            {cfg.allowedModels && cfg.allowedModels.length > 0 ? (
              <select value={model ?? ""} onChange={(e) => setModel(e.target.value || undefined)}>
                {cfg.allowedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={model ?? ""}
                onChange={(e) => setModel(e.target.value || undefined)}
                placeholder={cfg.defaultModel ?? "model"}
                aria-label="model"
              />
            )}
            <span className="ver">runtime v{cfg.version}</span>
          </div>
          {tab === "chat" ? (
            <ChatPanel baseUrl={baseUrl} model={model} jaegerBaseUrl={cfg.jaegerBaseUrl} />
          ) : (
            <SpecPanel baseUrl={baseUrl} />
          )}
        </>
      )}
    </main>
  );
}

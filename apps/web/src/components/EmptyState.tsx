// First-run state: a friendly intro and four prompt suggestions that start a
// real coding session against the connected runtime.
import { SUGGESTIONS } from "../lib/suggestions";
import { Icon } from "../ui/icons";

export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="empty-chat">
      <div className="empty-inner">
        <div className="em-mark">
          <Icon name="chat" />
        </div>
        <h2>Start a coding session</h2>
        <p>
          Send an instruction to the agent. It runs against your connected runtime and streams its
          reasoning, tool calls, and results in real time.
        </p>
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button className="sugg" key={s.key} onClick={() => onPick(s.prompt)} type="button">
              <span className="s-ic">
                <Icon name={s.icon} />
              </span>
              <span>
                <div className="s-label">{s.label}</div>
                <div className="s-prompt">{s.prompt}</div>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Prompt composer: auto-growing textarea, Enter-to-send (Shift+Enter newline),
// and a Send / Stop affordance that mirrors the turn state.
import { useRef, useState } from "react";
import { Button } from "../ui/primitives";

interface ComposerProps {
  busy: boolean;
  isFollowUp: boolean;
  onSend: (prompt: string) => void;
  onStop: () => void;
}

export function Composer({ busy, isFollowUp, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  function submit() {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-box">
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            placeholder={
              isFollowUp
                ? "Send a follow-up turn… the agent keeps the session context"
                : "Give the agent an instruction…"
            }
            aria-label="prompt"
            onChange={(e) => {
              setText(e.target.value);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-foot">
            <span className="hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
            </span>
            <span className="spacer" />
            {busy ? (
              <Button variant="destructive" icon="close" onClick={onStop}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" icon="send" onClick={submit} disabled={!text.trim()}>
                {isFollowUp ? "Send turn" : "Send"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

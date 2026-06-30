// Prompt composer: auto-growing textarea, Enter-to-send (Shift+Enter newline), optional image
// attachments (click-to-pick or drag-and-drop, shown as removable thumbnails), and a Send / Stop
// affordance that mirrors the turn state.
import { useRef, useState } from "react";
import {
  type ImageAttachment,
  MAX_IMAGES,
  MAX_TOTAL_BASE64_BYTES,
  parseImageDataUrl,
} from "../lib/content";
import { uid } from "../lib/format";
import { Button } from "../ui/primitives";

interface ComposerProps {
  busy: boolean;
  isFollowUp: boolean;
  onSend: (prompt: string, images: ImageAttachment[]) => void;
  onStop: () => void;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function Composer({ busy, isFollowUp, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  async function addFiles(files: File[]) {
    setError(null);
    const picked = files.filter((f) => f.type.startsWith("image/"));
    if (picked.length === 0) return;
    const next = [...images];
    let total = next.reduce((n, i) => n + i.base64.length, 0);
    for (const f of picked) {
      if (next.length >= MAX_IMAGES) {
        setError(`At most ${MAX_IMAGES} images per turn.`);
        break;
      }
      const dataUrl = await readAsDataUrl(f);
      const parsed = parseImageDataUrl(dataUrl);
      if (!parsed) {
        setError("Unsupported image type (use PNG, JPEG, GIF, or WebP).");
        continue;
      }
      total += parsed.base64.length;
      if (total > MAX_TOTAL_BASE64_BYTES) {
        setError("Images exceed the size limit.");
        break;
      }
      next.push({ id: uid(), dataUrl, mediaType: parsed.mediaType, base64: parsed.base64 });
    }
    setImages(next);
  }

  function removeImage(id: string) {
    setImages((prev) => prev.filter((i) => i.id !== id));
  }

  function submit() {
    const t = text.trim();
    if ((!t && images.length === 0) || busy) return;
    onSend(t, images);
    setText("");
    setImages([]);
    setError(null);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target wraps the text input */}
        <div
          className={`composer-box${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {images.length > 0 && (
            <div className="composer-thumbs">
              {images.map((img) => (
                <div key={img.id} className="composer-thumb">
                  <img src={img.dataUrl} alt="attachment" />
                  <button
                    type="button"
                    className="composer-thumb-x"
                    aria-label="remove image"
                    onClick={() => removeImage(img.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            placeholder={
              isFollowUp
                ? "Send a follow-up turn… the agent keeps the session context"
                : "Give the agent an instruction… (or drop an image)"
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
          {error && <div className="composer-error">{error}</div>}
          <div className="composer-foot">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              onClick={() => fileRef.current?.click()}
            >
              Image
            </Button>
            <span className="hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
            </span>
            <span className="spacer" />
            {busy ? (
              <Button variant="destructive" icon="close" onClick={onStop}>
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="send"
                onClick={submit}
                disabled={!text.trim() && images.length === 0}
              >
                {isFollowUp ? "Send turn" : "Send"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

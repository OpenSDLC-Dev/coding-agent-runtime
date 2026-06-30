// Multimodal content helpers for the composer: turn text + attached images into the runtime's `content`
// blocks, and parse image data URLs. Kept pure (no DOM) so it can be unit-tested; the FileReader/drag-drop
// glue lives in the Composer and is exercised in a real browser.

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const ALLOWED_IMAGE_TYPES: ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

// Mirror the runtime's bounds (apps/runtime/src/routes/sessions.ts) so the UI rejects early with a clear
// message; the server's 400 stays the authoritative backstop.
export const MAX_IMAGES = 16;
export const MAX_TOTAL_BASE64_BYTES = 10 * 1024 * 1024;

export interface ImageAttachment {
  id: string;
  dataUrl: string; // data:<mime>;base64,<data> — used for the thumbnail preview
  mediaType: ImageMediaType;
  base64: string; // raw base64 payload (no data: prefix) — sent to the runtime
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

// Split a "data:<mime>;base64,<data>" URL into mediaType + base64; null for a non-image or unsupported type.
export function parseImageDataUrl(
  dataUrl: string,
): { mediaType: ImageMediaType; base64: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const mediaType = m[1] as ImageMediaType;
  if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) return null;
  return { mediaType, base64: m[2] ?? "" };
}

// Assemble the runtime `content` array: the trimmed text first (when non-empty), then each image as a
// base64 block. Returns [] when there is nothing to send.
export function buildContentBlocks(text: string, images: ImageAttachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed) blocks.push({ type: "text", text: trimmed });
  for (const img of images) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  }
  return blocks;
}

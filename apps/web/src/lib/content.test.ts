import { describe, expect, it } from "vitest";
import { buildContentBlocks, type ImageAttachment, parseImageDataUrl } from "./content";

const img = (base64: string): ImageAttachment => ({
  id: "x",
  dataUrl: `data:image/png;base64,${base64}`,
  mediaType: "image/png",
  base64,
});

describe("buildContentBlocks", () => {
  it("puts trimmed text first, then each image as a base64 block", () => {
    expect(buildContentBlocks("  hi  ", [img("AAAA")])).toEqual([
      { type: "text", text: "hi" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("omits the text block when text is empty/whitespace", () => {
    expect(buildContentBlocks("   ", [img("AAAA")])).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("returns an empty array when there is nothing to send", () => {
    expect(buildContentBlocks("", [])).toEqual([]);
  });
});

describe("parseImageDataUrl", () => {
  it("splits a supported image data URL into mediaType + base64", () => {
    expect(parseImageDataUrl("data:image/png;base64,AAAA")).toEqual({
      mediaType: "image/png",
      base64: "AAAA",
    });
  });

  it("rejects an unsupported media type", () => {
    expect(parseImageDataUrl("data:image/svg+xml;base64,AAAA")).toBeNull();
  });

  it("rejects a non-data URL", () => {
    expect(parseImageDataUrl("http://example.com/x.png")).toBeNull();
  });
});

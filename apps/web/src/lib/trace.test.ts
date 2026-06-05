import { describe, expect, it } from "vitest";
import { traceUrl } from "./trace";

describe("traceUrl", () => {
  it("builds a Jaeger deep link", () => {
    expect(traceUrl("http://localhost:16686", "abc123")).toBe(
      "http://localhost:16686/trace/abc123",
    );
  });

  it("trims a trailing slash on the base", () => {
    expect(traceUrl("http://localhost:16686/", "abc")).toBe("http://localhost:16686/trace/abc");
  });

  it("returns null when base or traceId is missing", () => {
    expect(traceUrl(null, "abc")).toBeNull();
    expect(traceUrl("http://x", undefined)).toBeNull();
  });
});

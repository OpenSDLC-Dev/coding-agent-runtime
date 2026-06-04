import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { getTracer, shutdownTelemetry, startTelemetry } from "../src/telemetry.js";

describe("telemetry", () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it("does not start the SDK when no OTLP endpoint is configured", () => {
    expect(startTelemetry({}, "0.0.0")).toBe(false);
  });

  it("starts the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    const started = startTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      "1.2.3",
    );
    expect(started).toBe(true);
  });

  it("is idempotent (second start is a no-op returning true)", () => {
    startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    expect(startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toBe(true);
  });

  it("getTracer always returns a usable tracer (no-op when not started)", () => {
    const tracer = getTracer();
    const span = tracer.startSpan("probe");
    span.end();
    expect(typeof trace.getTracer).toBe("function");
  });
});

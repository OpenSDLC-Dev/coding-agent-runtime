import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "coding-agent-runtime";

let sdk: NodeSDK | undefined;

// Only start real export when an OTLP endpoint is configured (compose stack up); otherwise spans
// degrade to no-ops so a bare docker run produces no connection errors. Returns whether the real
// SDK was started; idempotent.
export function startTelemetry(env: NodeJS.ProcessEnv = process.env, version = "0.0.0"): boolean {
  if (sdk) return true;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || TRACER_NAME,
      [ATTR_SERVICE_VERSION]: version,
    }),
    // OTLPTraceExporter reads the endpoint from OTEL_EXPORTER_OTLP_ENDPOINT (auto-appends /v1/traces).
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  return true;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}

import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "coding-agent-runtime";

let sdk: NodeSDK | undefined;

// 仅当配置了 OTLP 端点（compose 起栈）才启动真实导出；否则 span 退化为 no-op，
// 裸 docker run 不产生连接错误。返回是否启动了真实 SDK；幂等。
export function startTelemetry(env: NodeJS.ProcessEnv = process.env, version = "0.0.0"): boolean {
  if (sdk) return true;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || TRACER_NAME,
      [ATTR_SERVICE_VERSION]: version,
    }),
    // OTLPTraceExporter 从 OTEL_EXPORTER_OTLP_ENDPOINT 读端点（自动追加 /v1/traces）。
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

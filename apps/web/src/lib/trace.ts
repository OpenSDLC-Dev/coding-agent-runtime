// Jaeger 深链：<jaegerBaseUrl>/trace/<traceId>。base 或 traceId 缺失返回 null（不渲染链接）。
export function traceUrl(jaegerBaseUrl: string | null, traceId: string | undefined): string | null {
  if (!jaegerBaseUrl || !traceId) return null;
  return `${jaegerBaseUrl.replace(/\/$/, "")}/trace/${traceId}`;
}

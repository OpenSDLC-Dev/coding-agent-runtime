// Jaeger deep link: <jaegerBaseUrl>/trace/<traceId>. Returns null when base or traceId is missing (link not rendered).
export function traceUrl(jaegerBaseUrl: string | null, traceId: string | undefined): string | null {
  if (!jaegerBaseUrl || !traceId) return null;
  return `${jaegerBaseUrl.replace(/\/$/, "")}/trace/${traceId}`;
}

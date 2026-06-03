export interface RuntimeConfig {
  anthropicBaseUrl: string | undefined;
  anthropicApiKey: string;
  defaultModel: string | undefined;
  includePartial: boolean;
  jaegerBaseUrl: string | undefined;
  port: number;
  cwd: string;
  hostname: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  return {
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    anthropicApiKey,
    defaultModel: env.RUNTIME_DEFAULT_MODEL || undefined,
    includePartial: env.INCLUDE_PARTIAL_MESSAGES === "1",
    jaegerBaseUrl: env.JAEGER_BASE_URL || undefined,
    port: Number(env.PORT) || 8080,
    cwd: env.RUNTIME_CWD || "/workspace",
    // 安全默认：仅绑回环；非隔离部署不会静默暴露。容器内由 Dockerfile 显式设 0.0.0.0（docker -p 需要）。
    hostname: env.RUNTIME_HOSTNAME || "127.0.0.1",
  };
}

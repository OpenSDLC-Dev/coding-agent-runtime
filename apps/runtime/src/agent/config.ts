export interface RuntimeConfig {
  anthropicBaseUrl: string | undefined;
  anthropicApiKey: string;
  defaultModel: string | undefined;
  includePartial: boolean;
  jaegerBaseUrl: string | undefined;
  port: number;
  cwd: string;
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
  };
}

export interface RuntimeConfig {
  anthropicBaseUrl: string | undefined;
  anthropicApiKey: string;
  defaultModel: string | undefined;
  allowedModels: string[] | undefined;
  includePartial: boolean;
  jaegerBaseUrl: string | undefined;
  corsOrigins: string;
  port: number;
  cwd: string;
  hostname: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  const allowedRaw = env.RUNTIME_ALLOWED_MODELS;
  const allowedModels = allowedRaw
    ? allowedRaw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : undefined;
  return {
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    anthropicApiKey,
    defaultModel: env.RUNTIME_DEFAULT_MODEL || undefined,
    allowedModels,
    includePartial: env.INCLUDE_PARTIAL_MESSAGES === "1",
    jaegerBaseUrl: env.JAEGER_BASE_URL || undefined,
    corsOrigins: env.CORS_ORIGINS || "*",
    port: Number(env.PORT) || 8080,
    cwd: env.RUNTIME_CWD || "/workspace",
    // 安全默认：仅绑回环；非隔离部署不会静默暴露。容器内由 Dockerfile 显式设 0.0.0.0（docker -p 需要）。
    hostname: env.RUNTIME_HOSTNAME || "127.0.0.1",
  };
}

// 仅校验"显式请求的模型"：未配置白名单 → 放行；未指定模型（走默认）→ 放行。
export function isModelAllowed(model: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!model) return true;
  return allowed.includes(model);
}

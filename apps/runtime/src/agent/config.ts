import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

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
  // Claude 推理强度（effort）。runtime 默认拉满 "max"（最大推理深度）；可经 RUNTIME_EFFORT 覆盖为
  // low/medium/high/xhigh/max（SDK 自身默认仅为 "high"）。注意：并非所有模型后端都支持 effort，
  // 不支持的后端会忽略该参数。
  effort: EffortLevel;
  // 独立安装的 Claude Code CLI 原生二进制路径。设置后经 SDK 的 pathToClaudeCodeExecutable 驱动它
  // （SDK 与 CLI 解耦：CLI 更新更频繁，可独立于 SDK 升级；二者经 stdio/stream-json 通信）。
  // 留空 → 回退 SDK 自带的平台二进制（本地 dev 用）。容器内由 Dockerfile 设为独立 CLI。
  claudeCliPath: string | undefined;
}

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// 解析 RUNTIME_EFFORT；缺省或非法值 → "max"（runtime 默认拉满推理强度）。
function parseEffort(raw: string | undefined): EffortLevel {
  return raw && (EFFORT_LEVELS as readonly string[]).includes(raw) ? (raw as EffortLevel) : "max";
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
    claudeCliPath: env.RUNTIME_CLAUDE_CLI_PATH || undefined,
    effort: parseEffort(env.RUNTIME_EFFORT),
  };
}

// 仅校验"显式请求的模型"：未配置白名单 → 放行；未指定模型（走默认）→ 放行。
export function isModelAllowed(model: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!model) return true;
  return allowed.includes(model);
}

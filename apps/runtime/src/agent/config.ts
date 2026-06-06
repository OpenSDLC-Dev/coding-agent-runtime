import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_BASH_ALLOWLIST } from "../permissions/bash-allowlist.js";

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
  // P3 第 1 层 Bash 白名单：PreToolUse hook 仅放行 argv[0] basename 在此表内的命令。
  // 经 RUNTIME_BASH_ALLOWLIST（逗号/空格分隔）覆盖；留空 → 内置 DEFAULT_BASH_ALLOWLIST。
  bashAllowlist: string[];
  // SSE 心跳间隔（毫秒）；0 = 禁用。经 RUNTIME_SSE_HEARTBEAT_MS 覆盖，默认 20000。
  heartbeatMs: number;
}

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// 解析 RUNTIME_EFFORT；缺省或非法值 → "max"（runtime 默认拉满推理强度）。
function parseEffort(raw: string | undefined): EffortLevel {
  return raw && (EFFORT_LEVELS as readonly string[]).includes(raw) ? (raw as EffortLevel) : "max";
}

// 解析 RUNTIME_BASH_ALLOWLIST（逗号/空格分隔）；缺省或空 → 内置默认白名单。
function parseBashAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_BASH_ALLOWLIST];
  const items = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [...DEFAULT_BASH_ALLOWLIST];
}

// 解析 RUNTIME_SSE_HEARTBEAT_MS；缺省/非法/负数 → 20000（0 合法，表示禁用）。
function parseHeartbeatMs(raw: string | undefined): number {
  if (raw === undefined) return 20000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 20000;
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
    bashAllowlist: parseBashAllowlist(env.RUNTIME_BASH_ALLOWLIST),
    heartbeatMs: parseHeartbeatMs(env.RUNTIME_SSE_HEARTBEAT_MS),
  };
}

// 仅校验"显式请求的模型"：未配置白名单 → 放行；未指定模型（走默认）→ 放行。
export function isModelAllowed(model: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!model) return true;
  return allowed.includes(model);
}

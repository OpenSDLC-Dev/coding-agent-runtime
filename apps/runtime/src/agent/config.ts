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
  // Claude reasoning effort. The runtime defaults to "max" (maximum reasoning depth); can be overridden
  // via RUNTIME_EFFORT to low/medium/high/xhigh/max (the SDK's own default is only "high"). Note: not all
  // model backends support effort; backends that do not will ignore this parameter.
  effort: EffortLevel;
  // Path to the natively installed Claude Code CLI binary. When set, it is driven via the SDK's
  // pathToClaudeCodeExecutable (the SDK and CLI are decoupled: the CLI updates more frequently and can be
  // upgraded independently of the SDK; the two communicate via stdio/stream-json).
  // Empty → fall back to the platform binary bundled with the SDK (for local dev). In the container, the Dockerfile sets this to the standalone CLI.
  claudeCliPath: string | undefined;
  // P3 layer 1 Bash allowlist: the PreToolUse hook only allows commands whose argv[0] basename is in this list.
  // Overridden via RUNTIME_BASH_ALLOWLIST (comma/space separated); empty → built-in DEFAULT_BASH_ALLOWLIST.
  bashAllowlist: string[];
  // SSE heartbeat interval (milliseconds); 0 = disabled. Overridden via RUNTIME_SSE_HEARTBEAT_MS, default 20000.
  heartbeatMs: number;
  // Runaway backstop: max agentic turns (API round-trips) before the SDK stops a turn. The Agent SDK has no
  // top-level session timeout, so this bounds an out-of-control/looping agent. Overridden via RUNTIME_MAX_TURNS;
  // default 100; 0 = unlimited (not recommended).
  maxTurns: number;
  // Optional wall-clock deadline for a single turn (ms). When > 0, the turn's AbortController fires at the deadline
  // (yielding an `aborted` event). Overridden via RUNTIME_TURN_TIMEOUT_MS; default 0 = disabled.
  turnTimeoutMs: number;
  // Admission control: max concurrent in-flight turns. Beyond this, a new turn is rejected with HTTP 429.
  // Bounds subprocess RAM so concurrent sessions cannot OOM the container. Overridden via RUNTIME_MAX_CONCURRENT_TURNS;
  // default 2 (aligned with the container's 2g mem_limit); 0 = unlimited.
  maxConcurrentTurns: number;
  // Idle-session GC: remove a session whose lastActiveAt is older than this (ms), reclaiming its on-disk transcript.
  // Overridden via RUNTIME_SESSION_TTL_MS; default 0 = disabled.
  sessionTtlMs: number;
  // How often the idle-session GC sweep runs (ms). Overridden via RUNTIME_GC_INTERVAL_MS; default 3600000 (1h).
  // Only active when sessionTtlMs > 0.
  gcIntervalMs: number;
  // Optional path to a declarative extensions manifest (JSON). When set, loadExtensions reads it and
  // folds external MCP servers / plugins / skills / dirs into the extension contributions. Overridden
  // via RUNTIME_EXTENSIONS_FILE; unset = no declarative extensions.
  extensionsManifestPath: string | undefined;
}

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// Parse RUNTIME_EFFORT; missing or invalid value → "max" (the runtime defaults to maximum reasoning effort).
function parseEffort(raw: string | undefined): EffortLevel {
  return raw && (EFFORT_LEVELS as readonly string[]).includes(raw) ? (raw as EffortLevel) : "max";
}

// Parse RUNTIME_BASH_ALLOWLIST (comma/space separated); missing or empty → built-in default allowlist.
function parseBashAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_BASH_ALLOWLIST];
  const items = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [...DEFAULT_BASH_ALLOWLIST];
}

// Parse RUNTIME_SSE_HEARTBEAT_MS; missing/invalid/negative → 20000 (0 is valid and means disabled).
function parseHeartbeatMs(raw: string | undefined): number {
  if (raw === undefined) return 20000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 20000;
}

// Parse a non-negative integer env var; missing/invalid/negative → fallback. 0 is preserved (a meaningful value: unlimited/disabled).
function parseNonNegInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Parse a positive integer env var; missing/invalid/non-positive → fallback.
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    // Secure default: bind to loopback only; non-isolated deployments are not silently exposed. In the container, the Dockerfile explicitly sets 0.0.0.0 (required by docker -p).
    hostname: env.RUNTIME_HOSTNAME || "127.0.0.1",
    claudeCliPath: env.RUNTIME_CLAUDE_CLI_PATH || undefined,
    effort: parseEffort(env.RUNTIME_EFFORT),
    bashAllowlist: parseBashAllowlist(env.RUNTIME_BASH_ALLOWLIST),
    heartbeatMs: parseHeartbeatMs(env.RUNTIME_SSE_HEARTBEAT_MS),
    maxTurns: parseNonNegInt(env.RUNTIME_MAX_TURNS, 100),
    turnTimeoutMs: parseNonNegInt(env.RUNTIME_TURN_TIMEOUT_MS, 0),
    maxConcurrentTurns: parseNonNegInt(env.RUNTIME_MAX_CONCURRENT_TURNS, 2),
    sessionTtlMs: parseNonNegInt(env.RUNTIME_SESSION_TTL_MS, 0),
    gcIntervalMs: parsePositiveInt(env.RUNTIME_GC_INTERVAL_MS, 3_600_000),
    extensionsManifestPath: env.RUNTIME_EXTENSIONS_FILE || undefined,
  };
}

// Only validate the "explicitly requested model": no allowlist configured → allow; no model specified (uses default) → allow.
export function isModelAllowed(model: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!model) return true;
  return allowed.includes(model);
}

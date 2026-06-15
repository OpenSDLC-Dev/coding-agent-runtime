import { describe, expect, it } from "vitest";
import { isModelAllowed, loadConfig } from "../src/agent/config.js";
import { DEFAULT_BASH_ALLOWLIST } from "../src/permissions/bash-allowlist.js";

describe("loadConfig", () => {
  it("throws when ANTHROPIC_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow("ANTHROPIC_API_KEY is required");
  });

  it("parses env into a RuntimeConfig", () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      RUNTIME_DEFAULT_MODEL: "MiniMax-M3",
      RUNTIME_ALLOWED_MODELS: "MiniMax-M3, claude-x",
      CORS_ORIGINS: "http://localhost:5173",
      PORT: "8080",
      INCLUDE_PARTIAL_MESSAGES: "1",
      JAEGER_BASE_URL: "http://localhost:16686",
      RUNTIME_HOSTNAME: "0.0.0.0",
      RUNTIME_CLAUDE_CLI_PATH: "/usr/local/bin/claude",
      RUNTIME_EFFORT: "high",
    });
    expect(cfg).toEqual({
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
      defaultModel: "MiniMax-M3",
      allowedModels: ["MiniMax-M3", "claude-x"],
      includePartial: true,
      jaegerBaseUrl: "http://localhost:16686",
      corsOrigins: "http://localhost:5173",
      port: 8080,
      cwd: "/workspace",
      hostname: "0.0.0.0",
      claudeCliPath: "/usr/local/bin/claude",
      effort: "high",
      bashAllowlist: [...DEFAULT_BASH_ALLOWLIST],
      heartbeatMs: 20000,
      maxTurns: 100,
      turnTimeoutMs: 0,
      maxConcurrentTurns: 2,
      sessionTtlMs: 0,
      gcIntervalMs: 3_600_000,
      idempotencyTtlMs: 600_000,
      extensionsManifestPath: undefined,
    });
  });

  it("applies defaults when optional env is absent", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(cfg.port).toBe(8080);
    expect(cfg.cwd).toBe("/workspace");
    expect(cfg.includePartial).toBe(false);
    expect(cfg.anthropicBaseUrl).toBeUndefined();
    expect(cfg.defaultModel).toBeUndefined();
    expect(cfg.hostname).toBe("127.0.0.1");
    expect(cfg.allowedModels).toBeUndefined();
    expect(cfg.corsOrigins).toBe("*");
    expect(cfg.claudeCliPath).toBeUndefined();
    expect(cfg.effort).toBe("max");
    expect(cfg.bashAllowlist).toEqual([...DEFAULT_BASH_ALLOWLIST]);
    expect(cfg.heartbeatMs).toBe(20000);
    expect(cfg.maxTurns).toBe(100);
    expect(cfg.turnTimeoutMs).toBe(0);
    expect(cfg.maxConcurrentTurns).toBe(2);
    expect(cfg.sessionTtlMs).toBe(0);
    expect(cfg.gcIntervalMs).toBe(3_600_000);
    expect(cfg.idempotencyTtlMs).toBe(600_000);
  });

  it("parses production-guard env vars (maxTurns, timeout, concurrency, GC, idempotency)", () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: "sk-test",
      RUNTIME_MAX_TURNS: "30",
      RUNTIME_TURN_TIMEOUT_MS: "60000",
      RUNTIME_MAX_CONCURRENT_TURNS: "4",
      RUNTIME_SESSION_TTL_MS: "86400000",
      RUNTIME_GC_INTERVAL_MS: "600000",
      RUNTIME_IDEMPOTENCY_TTL_MS: "0", // 0 disables the Idempotency-Key store
    });
    expect(cfg.maxTurns).toBe(30);
    expect(cfg.turnTimeoutMs).toBe(60000);
    expect(cfg.maxConcurrentTurns).toBe(4);
    expect(cfg.sessionTtlMs).toBe(86400000);
    expect(cfg.gcIntervalMs).toBe(600000);
    expect(cfg.idempotencyTtlMs).toBe(0);
  });

  it("allows 0 for maxTurns/concurrency (unlimited) but ignores invalid/non-positive gcInterval", () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: "sk-test",
      RUNTIME_MAX_TURNS: "0",
      RUNTIME_MAX_CONCURRENT_TURNS: "0",
      RUNTIME_GC_INTERVAL_MS: "0", // non-positive → fall back to default
      RUNTIME_TURN_TIMEOUT_MS: "-5", // invalid → fall back to default 0
    });
    expect(cfg.maxTurns).toBe(0);
    expect(cfg.maxConcurrentTurns).toBe(0);
    expect(cfg.gcIntervalMs).toBe(3_600_000);
    expect(cfg.turnTimeoutMs).toBe(0);
  });

  it("parses RUNTIME_EXTENSIONS_FILE into extensionsManifestPath", () => {
    expect(
      loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_EXTENSIONS_FILE: "/etc/ext.json" })
        .extensionsManifestPath,
    ).toBe("/etc/ext.json");
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-test" }).extensionsManifestPath).toBeUndefined();
  });

  it("falls back to max effort for an invalid RUNTIME_EFFORT value", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_EFFORT: "bogus" });
    expect(cfg.effort).toBe("max");
  });

  it("parses RUNTIME_BASH_ALLOWLIST (comma/space separated) overriding the default", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_BASH_ALLOWLIST: "git, ls  rg" });
    expect(cfg.bashAllowlist).toEqual(["git", "ls", "rg"]);
  });

  it("falls back to the default allowlist when RUNTIME_BASH_ALLOWLIST is blank", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_BASH_ALLOWLIST: "   " });
    expect(cfg.bashAllowlist).toEqual([...DEFAULT_BASH_ALLOWLIST]);
  });

  it("parses RUNTIME_SSE_HEARTBEAT_MS, allowing 0 to disable", () => {
    expect(
      loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "5000" }).heartbeatMs,
    ).toBe(5000);
    expect(
      loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "0" }).heartbeatMs,
    ).toBe(0);
  });

  it("falls back to 20000 for an invalid RUNTIME_SSE_HEARTBEAT_MS", () => {
    expect(
      loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "abc" }).heartbeatMs,
    ).toBe(20000);
    expect(
      loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "-3" }).heartbeatMs,
    ).toBe(20000);
  });
});

describe("isModelAllowed", () => {
  it("allows any model when allowlist is undefined or empty", () => {
    expect(isModelAllowed("anything", undefined)).toBe(true);
    expect(isModelAllowed("anything", [])).toBe(true);
  });
  it("allows omitted model (uses configured default)", () => {
    expect(isModelAllowed(undefined, ["MiniMax-M3"])).toBe(true);
  });
  it("enforces the allowlist for explicit models", () => {
    expect(isModelAllowed("MiniMax-M3", ["MiniMax-M3"])).toBe(true);
    expect(isModelAllowed("gpt-4", ["MiniMax-M3"])).toBe(false);
  });
});

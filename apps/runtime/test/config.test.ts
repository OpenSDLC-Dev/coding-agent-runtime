import { describe, expect, it } from "vitest";
import { isModelAllowed, loadConfig } from "../src/agent/config.js";

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
  });

  it("falls back to max effort for an invalid RUNTIME_EFFORT value", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_EFFORT: "bogus" });
    expect(cfg.effort).toBe("max");
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

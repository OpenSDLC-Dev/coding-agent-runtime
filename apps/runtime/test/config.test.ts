import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/agent/config.js";

describe("loadConfig", () => {
  it("throws when ANTHROPIC_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow("ANTHROPIC_API_KEY is required");
  });

  it("parses env into a RuntimeConfig", () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      RUNTIME_DEFAULT_MODEL: "MiniMax-M3",
      PORT: "8080",
      INCLUDE_PARTIAL_MESSAGES: "1",
      JAEGER_BASE_URL: "http://localhost:16686",
      RUNTIME_HOSTNAME: "0.0.0.0",
    });
    expect(cfg).toEqual({
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
      defaultModel: "MiniMax-M3",
      includePartial: true,
      jaegerBaseUrl: "http://localhost:16686",
      port: 8080,
      cwd: "/workspace",
      hostname: "0.0.0.0",
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
  });
});

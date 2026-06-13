import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { BUILTIN_EXTENSIONS } from "../src/extensions/builtin.js";
import { loadExtensions } from "../src/extensions/registry.js";
import type { Extension } from "../src/extensions/types.js";
import { testConfig } from "./helpers.js";

const noopHook: HookCallback = async () => ({});

describe("loadExtensions", () => {
  it("returns empty contributions when no extensions are registered", async () => {
    const out = await loadExtensions(testConfig, []);
    expect(out).toEqual({});
  });

  it("ships an empty builtin registry by default", () => {
    expect(BUILTIN_EXTENSIONS).toEqual([]);
  });

  it("folds a single extension's contributions", async () => {
    const ext: Extension = {
      name: "demo",
      setup: () => ({
        mcpServers: { demo: { type: "sdk", name: "demo" } as never },
        allowedTools: ["mcp__demo__ping"],
      }),
    };
    const out = await loadExtensions(testConfig, [ext]);
    expect(out.mcpServers?.demo).toBeDefined();
    expect(out.allowedTools).toEqual(["mcp__demo__ping"]);
  });

  it("concatenates allowedTools and merges hooks per event across extensions", async () => {
    const a: Extension = {
      name: "a",
      setup: () => ({
        allowedTools: ["mcp__a__x"],
        hooks: { PostToolUse: [{ hooks: [noopHook] }] },
      }),
    };
    const b: Extension = {
      name: "b",
      setup: () => ({
        allowedTools: ["mcp__b__y"],
        hooks: {
          PostToolUse: [{ hooks: [noopHook] }],
          PreToolUse: [{ matcher: "Write", hooks: [noopHook] }],
        },
      }),
    };
    const out = await loadExtensions(testConfig, [a, b]);
    expect(out.allowedTools).toEqual(["mcp__a__x", "mcp__b__y"]);
    expect(out.hooks?.PostToolUse).toHaveLength(2);
    expect(out.hooks?.PreToolUse).toHaveLength(1);
  });

  it("rejects a duplicate MCP server key across extensions (fail-fast)", async () => {
    const a: Extension = {
      name: "a",
      setup: () => ({ mcpServers: { shared: { type: "sdk", name: "shared" } as never } }),
    };
    const b: Extension = {
      name: "b",
      setup: () => ({ mcpServers: { shared: { type: "sdk", name: "shared" } as never } }),
    };
    await expect(loadExtensions(testConfig, [a, b])).rejects.toThrow(/duplicate MCP server key/i);
  });

  it("attributes a setup() failure to the offending extension by name", async () => {
    const bad: Extension = {
      name: "kaboom",
      setup: () => {
        throw new Error("boom");
      },
    };
    await expect(loadExtensions(testConfig, [bad])).rejects.toThrow(/kaboom/);
  });

  it("awaits an async setup()", async () => {
    const ext: Extension = {
      name: "async",
      setup: async () => ({ skills: "all" }),
    };
    const out = await loadExtensions(testConfig, [ext]);
    expect(out.skills).toBe("all");
  });
});

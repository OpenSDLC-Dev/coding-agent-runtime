import { createSdkMcpServer, type Options, tool } from "@anthropic-ai/claude-agent-sdk";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runTurn } from "../src/agent/runtime.js";
import { SessionRegistry } from "../src/agent/session-store.js";
import { loadExtensions } from "../src/extensions/registry.js";
import type { Extension } from "../src/extensions/types.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { recordingQueryFn, testConfig } from "./helpers.js";

// A representative operator extension: a single in-process custom tool.
const pingExtension: Extension = {
  name: "ping",
  setup: () => {
    const server = createSdkMcpServer({
      name: "demo",
      version: "1.0.0",
      tools: [
        tool("ping", "echo a message", { msg: z.string() }, async (args) => ({
          content: [{ type: "text", text: args.msg }],
        })),
      ],
    });
    return { mcpServers: { demo: server }, allowedTools: ["mcp__demo__ping"] };
  },
};

describe("extension subsystem end to end", () => {
  it("flows a custom tool from loadExtensions through runTurn into the SDK options", async () => {
    const contributions = await loadExtensions(testConfig, [pingExtension]);
    const { queryFn, captured } = recordingQueryFn();
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, queryFn, contributions)) {
      // drain
    }
    const opts = captured();
    expect(opts?.mcpServers?.demo).toBeDefined();
    expect(opts?.allowedTools).toContain("mcp__demo__ping");
    // perimeter intact
    expect(opts?.permissionMode).toBe("bypassPermissions");
    expect(opts?.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
  });

  it("threads contributions from the route layer through to query options", async () => {
    const contributions = await loadExtensions(testConfig, [pingExtension]);
    let captured: Options | undefined;
    const queryFn = (args: { prompt: string; options: Options }) => {
      captured = args.options;
      return (async function* () {})();
    };
    const app = new OpenAPIHono();
    registerSessionRoutes(app, {
      config: testConfig,
      queryFn,
      registry: new SessionRegistry(),
      sdk: {},
      version: "test",
      contributions,
    });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so the turn runs
    expect(captured?.mcpServers?.demo).toBeDefined();
    expect(captured?.allowedTools).toContain("mcp__demo__ping");
  });
});

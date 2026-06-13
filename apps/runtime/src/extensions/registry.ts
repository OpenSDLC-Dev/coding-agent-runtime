import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../agent/config.js";
import { BUILTIN_EXTENSIONS } from "./builtin.js";
import type { Extension, ExtensionContributions } from "./types.js";

/**
 * Build the merged extension contributions ONCE at startup.
 *
 * Each extension's `setup()` is called a single time (so stateful in-process MCP
 * servers / hook closures are created once and reused for every turn), and the
 * results are folded into one `ExtensionContributions`:
 * - `mcpServers` are merged with duplicate-key rejection (fail-fast).
 * - `allowedTools` / `plugins` / `additionalDirectories` are concatenated.
 * - `hooks` are merged per event.
 * - `skills` / `strictMcpConfig` take the last contributor's value.
 *
 * The `extensions` argument is injectable for tests; production passes the
 * compiled-in `BUILTIN_EXTENSIONS`.
 */
export async function loadExtensions(
  cfg: RuntimeConfig,
  extensions: Extension[] = BUILTIN_EXTENSIONS,
): Promise<ExtensionContributions> {
  const ctx = { cwd: cfg.cwd };

  const mcpServers: Record<string, McpServerConfig> = {};
  const allowedTools: string[] = [];
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  const plugins: ExtensionContributions["plugins"] = [];
  const additionalDirectories: string[] = [];
  let skills: ExtensionContributions["skills"];
  let strictMcpConfig: boolean | undefined;

  for (const ext of extensions) {
    let contrib: ExtensionContributions;
    try {
      contrib = await ext.setup(ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`extension "${ext.name}" failed during setup: ${reason}`);
    }

    for (const [key, server] of Object.entries(contrib.mcpServers ?? {})) {
      if (key in mcpServers) {
        throw new Error(`extension "${ext.name}" declares a duplicate MCP server key: "${key}"`);
      }
      mcpServers[key] = server;
    }

    if (contrib.allowedTools) allowedTools.push(...contrib.allowedTools);

    for (const event of Object.keys(contrib.hooks ?? {}) as HookEvent[]) {
      const matchers = contrib.hooks?.[event];
      if (matchers && matchers.length > 0) {
        hooks[event] = [...(hooks[event] ?? []), ...matchers];
      }
    }

    if (contrib.plugins) plugins.push(...contrib.plugins);
    if (contrib.additionalDirectories) additionalDirectories.push(...contrib.additionalDirectories);
    if (contrib.skills !== undefined) skills = contrib.skills;
    if (contrib.strictMcpConfig !== undefined) strictMcpConfig = contrib.strictMcpConfig;
  }

  // Emit only the fields that were actually contributed, so the composer's opt-in
  // checks (skills / strictMcpConfig / additionalDirectories) behave correctly.
  const result: ExtensionContributions = {};
  if (Object.keys(mcpServers).length > 0) result.mcpServers = mcpServers;
  if (allowedTools.length > 0) result.allowedTools = allowedTools;
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  if (plugins.length > 0) result.plugins = plugins;
  if (additionalDirectories.length > 0) result.additionalDirectories = additionalDirectories;
  if (skills !== undefined) result.skills = skills;
  if (strictMcpConfig !== undefined) result.strictMcpConfig = strictMcpConfig;
  return result;
}

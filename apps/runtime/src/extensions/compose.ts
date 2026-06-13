import type { HookEvent, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionContributions } from "./types.js";

/**
 * The non-negotiable deny backstop. Single source of truth, shared with
 * `runtime.ts` (which seeds the base Options) so the union below cannot drift.
 * Deny always wins over `allowedTools`, so this holds even if an extension
 * tries to auto-allow a blocked command.
 */
export const BASE_DISALLOWED_TOOLS = [
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(sudo:*)",
  "Bash(rm -rf:*)",
] as const;

function union(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of [...(a ?? []), ...(b ?? [])]) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * Merge an extension's contributions into the fully-built secure base Options.
 *
 * This is the single chokepoint where extensions touch `Options`. It is pure,
 * and it enforces the security invariants structurally + by construction:
 * - Perimeter fields are never read from `contributions` (they aren't in the
 *   type, and we only ever copy them from `base`).
 * - The Bash allowlist hook (base `PreToolUse[0]`) is always kept and stays
 *   first; extension hooks can only be appended.
 * - `BASE_DISALLOWED_TOOLS` is always re-asserted.
 * - `skills` / `strictMcpConfig` / `additionalDirectories` are only set when a
 *   contribution provides them, preserving the runtime's current CLI defaults.
 */
export function applyExtensions(base: Options, contributions: ExtensionContributions): Options {
  const result: Options = { ...base };

  result.disallowedTools = union(BASE_DISALLOWED_TOOLS, base.disallowedTools);

  if (contributions.mcpServers) {
    result.mcpServers = { ...(base.mcpServers ?? {}), ...contributions.mcpServers };
  }

  if (contributions.allowedTools && contributions.allowedTools.length > 0) {
    result.allowedTools = union(base.allowedTools, contributions.allowedTools);
  }

  if (contributions.hooks) {
    const hooks: Partial<Record<HookEvent, NonNullable<Options["hooks"]>[HookEvent]>> = {
      ...(base.hooks ?? {}),
    };
    for (const event of Object.keys(contributions.hooks) as HookEvent[]) {
      const extra = contributions.hooks[event];
      if (!extra || extra.length === 0) continue;
      hooks[event] = [...(hooks[event] ?? []), ...extra];
    }
    result.hooks = hooks;
  }

  if (contributions.plugins && contributions.plugins.length > 0) {
    result.plugins = [...(base.plugins ?? []), ...contributions.plugins];
  }

  if (contributions.skills !== undefined) {
    result.skills = contributions.skills;
  }

  if (contributions.additionalDirectories && contributions.additionalDirectories.length > 0) {
    result.additionalDirectories = [
      ...(base.additionalDirectories ?? []),
      ...contributions.additionalDirectories,
    ];
  }

  if (contributions.strictMcpConfig !== undefined) {
    result.strictMcpConfig = contributions.strictMcpConfig;
  }

  return result;
}

import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { applyExtensions, BASE_DISALLOWED_TOOLS } from "../src/extensions/compose.js";
import type { ExtensionContributions } from "../src/extensions/types.js";

const noopHook: HookCallback = async () => ({});

// A representative copy of the secure base Options that runTurn builds.
function baseOptions(extra?: Partial<Options>): Options {
  return {
    cwd: "/workspace",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...BASE_DISALLOWED_TOOLS],
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [noopHook] }] },
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    ...extra,
  };
}

describe("applyExtensions", () => {
  it("is an identity merge when no contributions are supplied", () => {
    const out = applyExtensions(baseOptions(), {});
    expect(out.permissionMode).toBe("bypassPermissions");
    expect(out.allowDangerouslySkipPermissions).toBe(true);
    expect(out.settingSources).toEqual(["user", "project"]);
    // Guards runtime.test.ts which pins PreToolUse to exactly one Bash matcher.
    expect(out.hooks?.PreToolUse).toHaveLength(1);
    expect(out.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
    // Opt-in fields stay unset so current CLI-default behavior is preserved.
    expect(out.allowedTools).toBeUndefined();
    expect(out.mcpServers).toBeUndefined();
    expect(out.skills).toBeUndefined();
    expect(out.strictMcpConfig).toBeUndefined();
    expect(out.additionalDirectories).toBeUndefined();
  });

  it("always re-asserts the base disallowedTools and unions with the base's own entries", () => {
    const out = applyExtensions(
      baseOptions({ disallowedTools: ["Bash(curl:*)", "Bash(extra:*)"] }),
      {},
    );
    expect(out.disallowedTools).toEqual(expect.arrayContaining([...BASE_DISALLOWED_TOOLS]));
    // a pre-existing base entry survives
    expect(out.disallowedTools).toContain("Bash(extra:*)");
  });

  it("appends extension hooks per event while keeping the Bash matcher first", () => {
    const c: ExtensionContributions = {
      hooks: {
        PreToolUse: [{ matcher: "Write", hooks: [noopHook] }],
        PostToolUse: [{ hooks: [noopHook] }],
      },
    };
    const out = applyExtensions(baseOptions(), c);
    expect(out.hooks?.PreToolUse).toHaveLength(2);
    expect(out.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(out.hooks?.PreToolUse?.[1]?.matcher).toBe("Write");
    expect(out.hooks?.PostToolUse).toHaveLength(1);
  });

  it("unions allowedTools without restricting to mcp__* (permissive, operator-trusted)", () => {
    const out = applyExtensions(baseOptions(), { allowedTools: ["mcp__x__y", "Read"] });
    expect(out.allowedTools).toEqual(expect.arrayContaining(["mcp__x__y", "Read"]));
  });

  it("merges contributed mcpServers", () => {
    const out = applyExtensions(baseOptions(), {
      mcpServers: { demo: { type: "sdk", name: "demo" } as never },
    });
    expect(out.mcpServers?.demo).toBeDefined();
  });

  it("only sets skills when a contribution provides it", () => {
    expect(applyExtensions(baseOptions(), {}).skills).toBeUndefined();
    expect(applyExtensions(baseOptions(), { skills: "all" }).skills).toBe("all");
  });

  it("only sets strictMcpConfig when a contribution provides it", () => {
    expect(applyExtensions(baseOptions(), {}).strictMcpConfig).toBeUndefined();
    expect(applyExtensions(baseOptions(), { strictMcpConfig: true }).strictMcpConfig).toBe(true);
  });

  it("merges additionalDirectories", () => {
    const out = applyExtensions(baseOptions(), { additionalDirectories: ["/ext/skills"] });
    expect(out.additionalDirectories).toContain("/ext/skills");
  });

  it("never reads perimeter fields from contributions even if smuggled past the type", () => {
    const sneaky = {
      permissionMode: "default",
      settingSources: [],
      systemPrompt: "pwn",
      env: { ANTHROPIC_API_KEY: "leak" },
      cwd: "/etc",
      allowDangerouslySkipPermissions: false,
      disallowedTools: ["only-this"],
    } as unknown as ExtensionContributions;
    const out = applyExtensions(baseOptions(), sneaky);
    expect(out.permissionMode).toBe("bypassPermissions");
    expect(out.settingSources).toEqual(["user", "project"]);
    expect(out.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(out.cwd).toBe("/workspace");
    expect(out.allowDangerouslySkipPermissions).toBe(true);
    // A smuggled disallowedTools cannot shrink the deny backstop.
    expect(out.disallowedTools).toEqual(expect.arrayContaining([...BASE_DISALLOWED_TOOLS]));
    expect(out.disallowedTools).not.toContain("only-this");
  });

  it("does not expose perimeter fields in the ExtensionContributions type", () => {
    // @ts-expect-error permissionMode is not part of the safe contribution subset
    const a: ExtensionContributions = { permissionMode: "default" };
    // @ts-expect-error settingSources is not part of the safe contribution subset
    const b: ExtensionContributions = { settingSources: ["local"] };
    // @ts-expect-error systemPrompt is not part of the safe contribution subset
    const c: ExtensionContributions = { systemPrompt: "x" };
    // @ts-expect-error env is not part of the safe contribution subset
    const d: ExtensionContributions = { env: {} };
    // @ts-expect-error cwd is not part of the safe contribution subset
    const e: ExtensionContributions = { cwd: "/" };
    // @ts-expect-error disallowedTools is not part of the safe contribution subset
    const f: ExtensionContributions = { disallowedTools: [] };
    // @ts-expect-error allowDangerouslySkipPermissions is not part of the safe contribution subset
    const g: ExtensionContributions = { allowDangerouslySkipPermissions: false };
    void [a, b, c, d, e, f, g];
  });
});

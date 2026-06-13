import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  SdkPluginConfig,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The safe subset of the SDK `Options` an extension is allowed to contribute.
 *
 * This is deliberately a hand-written interface, NOT `Partial<Options>`: the
 * security-perimeter fields (`permissionMode`, `allowDangerouslySkipPermissions`,
 * `settingSources`, `systemPrompt`, `env`, `cwd`, `model`, `effort`,
 * `disallowedTools`, `maxTurns`, `resume`, ...) are intentionally absent, so an
 * extension cannot even express a change to them. The runtime composer
 * (`applyExtensions`) is the only place these contributions touch the real
 * `Options`, and it never reads anything outside this shape.
 */
/** Read-only runtime facts handed to an extension's `setup()`. */
export interface ExtensionContext {
  /** The runtime working directory (`RuntimeConfig.cwd`), e.g. for resolving relative paths. */
  readonly cwd: string;
}

/**
 * A code extension: a named unit whose `setup()` runs once at startup and returns
 * its contributions. `setup()` is where a programmatic extension instantiates a
 * stateful in-process MCP server (`createSdkMcpServer`) or captures hook closures;
 * the result is reused for every turn.
 */
export interface Extension {
  /** Unique name, used for dedupe and error attribution. */
  readonly name: string;
  setup(ctx: ExtensionContext): ExtensionContributions | Promise<ExtensionContributions>;
}

export interface ExtensionContributions {
  /** Custom in-process tools (via `createSdkMcpServer`) and/or external MCP servers. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tool names auto-allowed without a prompt. Unioned with the base; not restricted to `mcp__*`. */
  allowedTools?: string[];
  /** Extra hook matchers per event, appended after the base hooks (the Bash allowlist stays first). */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Local plugin directories bundling skills/hooks/commands. */
  plugins?: SdkPluginConfig[];
  /** Enable/filter skills for the main session. Only applied when provided. */
  skills?: string[] | "all";
  /** Extra discovery roots for skills/plugins. */
  additionalDirectories?: string[];
  /** Ignore on-disk MCP config and honor only option-passed servers. Only applied when provided. */
  strictMcpConfig?: boolean;
}

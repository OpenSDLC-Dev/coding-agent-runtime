# Extensions — operator authoring guide

The runtime ships a self-contained extension subsystem (`apps/runtime/src/extensions/`) that lets
an **operator** add custom tools, external MCP servers, hooks, and skills to every agent turn —
without editing the runtime core. This is the full authoring reference; the
[README "Extensions" section](../README.md#extensions) is the short overview.

> ⚠️ **Extensions are an operator trust boundary.** They are supplied by whoever runs the
> container, never by remote users. Read [Security and trust boundary](#security-and-trust-boundary)
> before adding one — custom tools and MCP servers run **outside** the Bash allowlist.

## How it works

```
index.ts (startup, once)
  loadExtensions(config) ──► ExtensionContributions   (in-process MCP instances, hook closures)
        │  threaded through ServerDeps → SessionRouteDeps → runTurn
        ▼
runTurn(input, cfg, queryFn, contributions)
  baseOptions  = the secure base Options       ← every security-perimeter field is fixed here
  options      = applyExtensions(baseOptions, contributions)   ← the single merge chokepoint
  queryFn({ prompt, options })
```

- **Built once, reused every turn.** `loadExtensions(config)` runs a single time at startup
  (`apps/runtime/src/index.ts`). Stateful objects — in-process MCP server instances and hook
  closures — are created there and shared across all sessions and turns. If loading fails, the
  runtime logs the error and exits (fail-fast); it never boots half-configured.
- **One merge chokepoint.** Every contribution is layered onto the secure base `Options` by a
  single pure function, `applyExtensions(base, contributions)` (`compose.ts`). It is the only place
  extensions touch the SDK options, and it never mutates the base.
- **No-op by default.** With nothing configured, `applyExtensions` returns options equivalent to
  the base, so turn behavior is unchanged.

## Two authoring tiers

|                | Code tier                                   | Declarative tier                                      |
| -------------- | ------------------------------------------- | ----------------------------------------------------- |
| **Where**      | `apps/runtime/src/extensions/builtin.ts`    | a JSON file pointed to by `RUNTIME_EXTENSIONS_FILE`   |
| **For**        | in-process custom tools + hook callbacks (live JS) | external MCP servers, local plugins, skills, discovery dirs (serializable data) |
| **Rebuild?**   | yes — compiled into the image               | no — change the JSON and restart                      |

Both tiers fold into the same `applyExtensions` chokepoint, so the [security invariants](#security-and-trust-boundary)
hold for both. Use the code tier when you need real JavaScript (a tool handler, a hook callback);
use the declarative tier for anything that is just data.

## What an extension can contribute

`ExtensionContributions` (`types.ts`) is a deliberately **hand-written safe subset** of the SDK
`Options`. The security-perimeter fields (`permissionMode`, `disallowedTools`, `settingSources`,
`systemPrompt`, `env`, `cwd`, `model`, `effort`, `maxTurns`, `resume`, …) are intentionally **not in
the type**, so an extension cannot even express a change to them.

| Field                  | Type                                              | How it merges onto the base                                                              |
| ---------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `mcpServers`           | `Record<string, McpServerConfig>`                 | shallow-merged; a key used by more than one source fails fast at startup                 |
| `allowedTools`         | `string[]`                                        | de-duplicated union with the base (which sets none); **not** restricted to `mcp__*`      |
| `hooks`                | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | appended per event, *after* the base hooks — the Bash allowlist matcher always stays first |
| `plugins`              | `SdkPluginConfig[]`                               | concatenated after the base plugins                                                      |
| `skills`               | `string[] \| "all"`                               | replaces; **only applied when provided** (see the [skills gotcha](#skills-a-gotcha))     |
| `additionalDirectories`| `string[]`                                        | concatenated after the base dirs                                                         |
| `strictMcpConfig`      | `boolean`                                          | set; **only applied when provided** (default leaves the CLI behavior untouched)          |

When several extensions are loaded, the registry folds them in declaration order: `allowedTools`,
`plugins`, `additionalDirectories`, and per-event `hooks` are concatenated; `skills` and
`strictMcpConfig` take the **last** contributor's value; and a duplicate `mcpServers` key across any
two sources is rejected. The declarative manifest (when configured) is folded **after** the code
extensions, so its MCP keys are deduplicated against them too.

## Code tier — custom tools and hooks

An extension is a named unit with a `setup(ctx)` that returns its contributions. `setup` runs once
at startup, may be `async`, and receives a read-only `ctx` (currently `{ cwd }`).

### A custom tool

```ts
// apps/runtime/src/extensions/my-tools.ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Extension } from "./types.js";

export const myTools: Extension = {
  name: "my-tools",
  setup: () => {
    const server = createSdkMcpServer({
      name: "demo",
      version: "1.0.0",
      tools: [
        tool(
          "ping",
          "Echo a message back",
          { msg: z.string() },
          async (args) => ({ content: [{ type: "text", text: args.msg }] }),
        ),
      ],
    });
    return {
      mcpServers: { demo: server },
      allowedTools: ["mcp__demo__ping"],
    };
  },
};
```

Register it in `BUILTIN_EXTENSIONS`:

```ts
// apps/runtime/src/extensions/builtin.ts
import { myTools } from "./my-tools.js";
import type { Extension } from "./types.js";

export const BUILTIN_EXTENSIONS: Extension[] = [myTools];
```

Then rebuild (`pnpm --filter @app/runtime build`, or rebuild the container image).

> **Tip:** a tool handler should signal failure by returning `{ content: [...], isError: true }`
> rather than throwing — an uncaught throw aborts the whole turn.

### A hook callback

Extension hooks are appended *after* the base hooks for each event, so the Bash allowlist
`PreToolUse` matcher always remains first and a deny still wins. A simple `PostToolUse` audit hook:

```ts
// apps/runtime/src/extensions/audit-hook.ts
import type { Extension } from "./types.js";

export const auditHook: Extension = {
  name: "audit-hook",
  setup: () => ({
    hooks: {
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              console.log(`tool used: ${input.tool_name}`);
              return {};
            },
          ],
        },
      ],
    },
  }),
};
```

## Declarative tier — the JSON manifest

Point `RUNTIME_EXTENSIONS_FILE` at a JSON file (mounted into the container) for the serializable
contributions — external MCP servers, local plugins, skill enablement, and discovery dirs. No code,
no rebuild. The manifest is parsed and **strictly** validated at startup: unknown keys (top-level or
inside a block) are rejected, so a typo like `comand` is an error rather than being silently
dropped. In-process tool instances and `hooks` cannot appear here — they need the code tier.

### Full example

```jsonc
// extensions.json
{
  "mcpServers": {
    // HTTP transport
    "company-api": {
      "type": "http",
      "url": "https://internal.example.com/mcp",
      "headers": { "authorization": "Bearer ..." }
    },
    // stdio transport (a local subprocess; `type` defaults to "stdio")
    "local-tool": { "command": "my-mcp-server", "args": ["--stdio"] }
  },
  "allowedTools": ["mcp__company-api__*", "mcp__local-tool__*"],
  "plugins": [{ "type": "local", "path": "/ext/bundle", "skipMcpDiscovery": true }],
  "skills": ["code-review", "deploy"],
  "additionalDirectories": ["/ext/skills"],
  "strictMcpConfig": false
}
```

```bash
RUNTIME_EXTENSIONS_FILE=/etc/coding-agent-runtime/extensions.json
```

### Field reference

All top-level fields are optional.

| Field                   | Shape                                                      |
| ----------------------- | ---------------------------------------------------------- |
| `mcpServers`            | record of name → MCP server (stdio / SSE / HTTP; see below) |
| `allowedTools`          | `string[]`                                                 |
| `plugins`               | array of `{ "type": "local", "path": string, "skipMcpDiscovery"?: boolean }` |
| `skills`                | `"all"` or `string[]`                                      |
| `additionalDirectories` | `string[]`                                                 |
| `strictMcpConfig`       | `boolean`                                                  |

MCP server transports (each block is strict):

| Transport | Required               | Optional                                          |
| --------- | ---------------------- | ------------------------------------------------- |
| **stdio** | `command`              | `type: "stdio"`, `args`, `env`, `timeout`, `alwaysLoad` |
| **sse**   | `type: "sse"`, `url`   | `headers`, `tools`, `timeout`, `alwaysLoad`       |
| **http**  | `type: "http"`, `url`  | `headers`, `tools`, `timeout`, `alwaysLoad`       |

## Tool naming and `allowedTools`

Tools from an MCP server are exposed to the agent as `mcp__<key>__<tool>`, where `<key>` is the name
you register the server under in `mcpServers`. So the `ping` tool on a server registered as `demo`
is `mcp__demo__ping`. List the exact names — or an `mcp__<key>__*` wildcard — in `allowedTools` so
the agent can call them without a permission prompt. (Keeping the `createSdkMcpServer({ name })`
equal to the registration key, as the example does, avoids confusion.)

`allowedTools` is a *union* with the base and is **not** restricted to `mcp__*`: it is purely an
allow-list and cannot widen the deny side. The Bash allowlist hook and `BASE_DISALLOWED_TOOLS`
(`curl`, `wget`, `sudo`, `rm -rf`) always win, so a contributed `Bash(...)` entry cannot bypass
them.

## Skills: a gotcha

The base runtime sets `settingSources: ["user", "project"]` and leaves `skills` unset, so the CLI's
**default skill discovery** is in effect: skills under the mounted `.claude/skills`, plus any in
`plugins` / `additionalDirectories`, are all available. **Setting `skills` switches from "discover
everything" to "this explicit list only".** If you set `skills: ["deploy"]`, every other discovered
skill is hidden.

- To *add* discovery roots without filtering, use `additionalDirectories` / `plugins` and leave
  `skills` unset.
- To explicitly enable all discovered skills, set `skills: "all"`.
- Set an explicit `skills` array only when you genuinely want to restrict the set.

## Verifying and troubleshooting

- **Confirm a tool loaded.** The `init` SSE event carries the `tools` list the agent sees; your
  `mcp__<key>__<tool>` (or the external MCP server's tool names) should appear there.
- **Fail-fast errors at startup** (logged to stderr, then exit 1):
  - `extension "<name>" declares a duplicate MCP server key: "<key>"` — two sources used the same
    `mcpServers` key.
  - `extension "<name>" failed during setup: <reason>` — a code extension's `setup()` threw.
  - `extensions manifest is not valid JSON: <reason>` — `RUNTIME_EXTENSIONS_FILE` is not parseable
    JSON.
  - `extensions manifest is invalid: <reason>` — the manifest failed schema validation (unknown
    key, wrong type, or a missing required field such as an `http` server's `url`).
  - `failed to read extensions manifest at <path>: <reason>` — the manifest path is unreadable.

## Security and trust boundary

Extensions are supplied by the **operator**, not by remote users. The composer structurally
prevents a contribution from changing the security perimeter — the perimeter fields are absent from
`ExtensionContributions`, the Bash allowlist hook is always kept first, and `BASE_DISALLOWED_TOOLS`
is always re-asserted (deny wins over any contributed `allowedTools`).

**But custom tools and MCP servers run *outside* the Bash allowlist** — that hook matches only
`Bash`, so an in-process tool or an external MCP server can do whatever its own code does. The real
backstop for them is the **container hardening** (read-only rootfs, `cap_drop: ALL`,
`no-new-privileges`, resource limits, and the optional `container/egress-allowlist.sh`). Only load
extensions you trust, and treat "a new in-process tool / external MCP server" as a security-relevant
change in review. See [`docs/superpowers/SECURITY-p3.md`](superpowers/SECURITY-p3.md) for the threat
model.

## Out of scope

The subsystem is deliberately small. It does **not** expose sub-agents (`agents`), hot-reload, or
per-session / per-request extensions, and there is no plugin marketplace. Environment-driven config
(everything except the manifest file) is not extensible this way. Add these only when a concrete
need appears.

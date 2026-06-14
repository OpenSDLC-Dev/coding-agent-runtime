import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ExtensionContributions } from "./types.js";

// The declarative tier carries only serializable contributions. In-process custom tools
// (createSdkMcpServer instances) and in-process hook callbacks are live JS and must use the
// code tier (builtin.ts) instead — so this manifest accepts stdio/SSE/HTTP MCP transports,
// local plugin dirs, skill enablement, and discovery dirs, but NOT `mcpServers` SDK instances
// or `hooks`. Unknown top-level keys are rejected to catch those mistakes early.

const stringRecord = z.record(z.string(), z.string());
const toolPolicy = z.array(z.unknown());

const mcpStdio = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: stringRecord.optional(),
  timeout: z.number().optional(),
  alwaysLoad: z.boolean().optional(),
});

const mcpSse = z.object({
  type: z.literal("sse"),
  url: z.string(),
  headers: stringRecord.optional(),
  tools: toolPolicy.optional(),
  timeout: z.number().optional(),
  alwaysLoad: z.boolean().optional(),
});

const mcpHttp = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: stringRecord.optional(),
  tools: toolPolicy.optional(),
  timeout: z.number().optional(),
  alwaysLoad: z.boolean().optional(),
});

const mcpServer = z.union([mcpSse, mcpHttp, mcpStdio]);

const plugin = z.object({
  type: z.literal("local"),
  path: z.string(),
  skipMcpDiscovery: z.boolean().optional(),
});

const manifestSchema = z
  .object({
    mcpServers: z.record(z.string(), mcpServer).optional(),
    allowedTools: z.array(z.string()).optional(),
    plugins: z.array(plugin).optional(),
    skills: z.union([z.literal("all"), z.array(z.string())]).optional(),
    additionalDirectories: z.array(z.string()).optional(),
    strictMcpConfig: z.boolean().optional(),
  })
  .strict();

/** Parse + validate a declarative extensions manifest from a JSON string. */
export function parseManifest(text: string): ExtensionContributions {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`extensions manifest is not valid JSON: ${reason}`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`extensions manifest is invalid: ${parsed.error.message}`);
  }
  // The validated shape is a structural subset of ExtensionContributions; the MCP transports
  // are exactly the serializable McpServerConfig variants (sans the SDK-instance variant).
  return parsed.data as ExtensionContributions;
}

/** Read + parse a declarative extensions manifest from a file path. */
export function loadManifestFile(path: string): ExtensionContributions {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read extensions manifest at ${path}: ${reason}`);
  }
  return parseManifest(text);
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/extensions/declarative.js";
import { loadExtensions } from "../src/extensions/registry.js";
import type { Extension } from "../src/extensions/types.js";
import { testConfig } from "./helpers.js";

function writeManifest(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
  const path = join(dir, "extensions.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("parseManifest", () => {
  it("parses a full declarative manifest", () => {
    const out = parseManifest(
      JSON.stringify({
        mcpServers: {
          api: { type: "http", url: "https://example.com/mcp", headers: { "x-key": "v" } },
          local: { command: "my-server", args: ["--stdio"] },
        },
        allowedTools: ["mcp__api__*"],
        plugins: [{ type: "local", path: "/ext/bundle", skipMcpDiscovery: true }],
        skills: ["code-review", "deploy"],
        additionalDirectories: ["/ext/skills"],
        strictMcpConfig: true,
      }),
    );
    expect(out.mcpServers?.api).toMatchObject({ type: "http", url: "https://example.com/mcp" });
    expect(out.mcpServers?.local).toMatchObject({ command: "my-server" });
    expect(out.allowedTools).toEqual(["mcp__api__*"]);
    expect(out.plugins?.[0]).toMatchObject({ type: "local", path: "/ext/bundle" });
    expect(out.skills).toEqual(["code-review", "deploy"]);
    expect(out.additionalDirectories).toEqual(["/ext/skills"]);
    expect(out.strictMcpConfig).toBe(true);
  });

  it('accepts skills: "all"', () => {
    expect(parseManifest(JSON.stringify({ skills: "all" })).skills).toBe("all");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseManifest("{ not json")).toThrow(/valid JSON/i);
  });

  it("rejects an unknown top-level key (e.g. hooks, which require code)", () => {
    expect(() => parseManifest(JSON.stringify({ hooks: {} }))).toThrow(/invalid/i);
  });

  it("rejects a wrong field type", () => {
    expect(() => parseManifest(JSON.stringify({ allowedTools: "nope" }))).toThrow(/invalid/i);
  });

  it("rejects an http server without a url", () => {
    expect(() => parseManifest(JSON.stringify({ mcpServers: { x: { type: "http" } } }))).toThrow(
      /invalid/i,
    );
  });
});

describe("loadExtensions with a manifest file", () => {
  it("folds the manifest's contributions", async () => {
    const path = writeManifest(JSON.stringify({ skills: "all", allowedTools: ["mcp__a__b"] }));
    const out = await loadExtensions({ ...testConfig, extensionsManifestPath: path }, []);
    expect(out.skills).toBe("all");
    expect(out.allowedTools).toEqual(["mcp__a__b"]);
  });

  it("rejects a duplicate MCP server key between a code extension and the manifest", async () => {
    const path = writeManifest(JSON.stringify({ mcpServers: { shared: { command: "x" } } }));
    const code: Extension = {
      name: "code",
      setup: () => ({ mcpServers: { shared: { type: "sdk", name: "shared" } as never } }),
    };
    await expect(
      loadExtensions({ ...testConfig, extensionsManifestPath: path }, [code]),
    ).rejects.toThrow(/duplicate MCP server key/i);
  });

  it("is a no-op when no manifest path is configured", async () => {
    const out = await loadExtensions({ ...testConfig, extensionsManifestPath: undefined }, []);
    expect(out).toEqual({});
  });
});

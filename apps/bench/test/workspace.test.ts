import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeGitDir, resetWorkspace, seedFiles } from "../src/workspace.js";

describe("workspace safety", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "ws-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("refuses a non-absolute workspace path", async () => {
    await expect(resetWorkspace("relative/dir")).rejects.toThrow(/absolute path/);
  });

  it("refuses to wipe a directory that contains a .git entry", async () => {
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, "keep.txt"), "important", "utf8");
    await expect(resetWorkspace(ws)).rejects.toThrow(/git repository root/);
    // The guard must fire before any deletion.
    expect(await readdir(ws)).toContain("keep.txt");
  });

  it("empties an existing workspace but keeps the directory", async () => {
    await writeFile(join(ws, "stale.txt"), "old", "utf8");
    await mkdir(join(ws, "sub"), { recursive: true });
    await resetWorkspace(ws);
    expect(await readdir(ws)).toEqual([]);
  });

  it("seeds nested files into the workspace", async () => {
    await resetWorkspace(ws);
    await seedFiles(ws, { "src/add.mjs": "export const a = 1;\n", "top.txt": "hi" });
    expect(await readFile(join(ws, "src/add.mjs"), "utf8")).toContain("export const a");
    expect(await readFile(join(ws, "top.txt"), "utf8")).toBe("hi");
  });

  it("removeGitDir deletes a .git but keeps other files, and is a no-op when absent", async () => {
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, "keep.txt"), "x", "utf8");
    await removeGitDir(ws);
    const entries = await readdir(ws);
    expect(entries).toContain("keep.txt");
    expect(entries).not.toContain(".git");
    // Idempotent: removing again with no .git present does not throw.
    await expect(removeGitDir(ws)).resolves.toBeUndefined();
  });

  it("removeGitDir refuses a non-absolute path", async () => {
    await expect(removeGitDir("relative/dir")).rejects.toThrow(/absolute path/);
  });
});

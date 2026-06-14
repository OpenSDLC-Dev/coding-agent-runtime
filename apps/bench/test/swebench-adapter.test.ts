import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitClone } from "../src/adapters/swebench/git.js";
import { createSweBenchAdapter } from "../src/adapters/swebench/index.js";
import { SYNTHETIC_DATASET } from "./swebench-fixtures.js";

describe("swe-bench adapter", () => {
  let dir: string;
  let datasetFile: string;
  let subsetFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swead-"));
    datasetFile = join(dir, "dataset.json");
    subsetFile = join(dir, "subset.json");
    await writeFile(datasetFile, SYNTHETIC_DATASET, "utf8");
    await writeFile(subsetFile, JSON.stringify(["acme__gadget-7", "acme__widget-101"]), "utf8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the curated subset in order with empty seed files", async () => {
    const adapter = createSweBenchAdapter(
      { datasetFile, subsetFile, datasetSplit: "lite-curated" },
      { gitClone: async () => {} },
    );
    await adapter.load?.();
    const list = adapter.instances();
    expect(list.map((i) => i.id)).toEqual(["acme__gadget-7", "acme__widget-101"]);
    for (const inst of list) {
      expect(inst.seedFiles).toEqual({});
      expect(inst.prompt).toContain("--- ISSUE ---");
      expect(inst.prepare).toBeTypeOf("function");
    }
  });

  it("prepare() clones the right repo at the right commit exactly once", async () => {
    const clones: Array<{ repo: string; baseCommit: string; ws: string }> = [];
    const gitClone: GitClone = async (repo, baseCommit, ws) => {
      clones.push({ repo, baseCommit, ws });
    };
    const adapter = createSweBenchAdapter(
      { datasetFile, subsetFile, datasetSplit: "lite-curated" },
      { gitClone },
    );
    await adapter.load?.();
    await adapter.instances()[1]?.prepare?.("/work");
    expect(clones).toEqual([
      { repo: "acme/widget", baseCommit: "0123456789abcdef0123456789abcdef01234567", ws: "/work" },
    ]);
  });

  it("instances() throws if used before load()", () => {
    const adapter = createSweBenchAdapter(
      { datasetFile, subsetFile, datasetSplit: "lite-curated" },
      { gitClone: async () => {} },
    );
    expect(() => adapter.instances()).toThrow(/before load/);
  });

  it("rejects a curated subset with duplicate ids", async () => {
    await writeFile(subsetFile, JSON.stringify(["acme__widget-101", "acme__widget-101"]), "utf8");
    const adapter = createSweBenchAdapter(
      { datasetFile, subsetFile, datasetSplit: "lite-curated" },
      { gitClone: async () => {} },
    );
    await expect(adapter.load?.()).rejects.toThrow(/duplicate/);
  });
});

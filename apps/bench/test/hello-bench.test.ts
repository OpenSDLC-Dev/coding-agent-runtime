import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { helloBench } from "../src/adapters/hello-bench/index.js";

async function seed(ws: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(ws, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
  }
}

// A correct implementation per instance, used to prove the check passes once the task is solved.
const FIXED: Record<string, Record<string, string>> = {
  "add-returns-sum": { "src/add.mjs": "export function add(a, b) {\n  return a + b;\n}\n" },
  "greet-name": {
    "src/greet.mjs": 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n',
  },
  "is-even": { "src/is-even.mjs": "export function isEven(n) {\n  return n % 2 === 0;\n}\n" },
};

describe("hello-bench adapter", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "hello-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("exposes three instances with unique ids, prompts, and seed files", () => {
    const list = helloBench.instances();
    const ids = list.map((i) => i.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const inst of list) {
      expect(inst.prompt.length).toBeGreaterThan(20);
      expect(Object.keys(inst.seedFiles).length).toBeGreaterThan(0);
      expect(inst.check).toBeTypeOf("function");
    }
  });

  it("check returns false for the broken seed", async () => {
    for (const inst of helloBench.instances()) {
      await seed(ws, inst.seedFiles);
      expect(await inst.check?.(ws)).toBe(false);
    }
  });

  it("check returns true once the file is corrected", async () => {
    for (const inst of helloBench.instances()) {
      const fix = FIXED[inst.id];
      expect(fix).toBeDefined();
      await seed(ws, fix ?? {});
      expect(await inst.check?.(ws)).toBe(true);
    }
  });
});

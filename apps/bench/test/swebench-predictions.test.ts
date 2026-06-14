import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectModelPatch,
  type Exec,
  writePredictions,
} from "../src/adapters/swebench/predictions.js";

describe("swebench predictions", () => {
  it("collectModelPatch runs `git add -A` then `git diff --cached` and returns the diff", async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const exec: Exec = async (file, args, cwd) => {
      calls.push({ file, args, cwd });
      return { stdout: args[0] === "diff" ? "THE-PATCH" : "" };
    };
    const patch = await collectModelPatch("/ws", exec);
    expect(patch).toBe("THE-PATCH");
    expect(calls).toEqual([
      { file: "git", args: ["add", "-A"], cwd: "/ws" },
      { file: "git", args: ["diff", "--cached"], cwd: "/ws" },
    ]);
  });

  describe("writePredictions", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "preds-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("writes the flat-list JSON with exactly the three prediction keys", async () => {
      const path = join(dir, "preds.json");
      await writePredictions(path, [
        { instance_id: "acme__widget-101", model_name_or_path: "m", model_patch: "diff" },
      ]);
      const parsed = JSON.parse(await readFile(path, "utf8"));
      expect(parsed).toEqual([
        { instance_id: "acme__widget-101", model_name_or_path: "m", model_patch: "diff" },
      ]);
    });

    it("rejects a record missing model_patch", async () => {
      const path = join(dir, "preds.json");
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input for the schema guard.
        writePredictions(path, [{ instance_id: "x", model_name_or_path: "m" } as any]),
      ).rejects.toThrow();
    });
  });
});

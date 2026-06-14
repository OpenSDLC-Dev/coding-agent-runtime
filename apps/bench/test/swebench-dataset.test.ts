import { describe, expect, it } from "vitest";
import { parseDataset, selectSubset } from "../src/adapters/swebench/dataset.js";
import { SYNTHETIC_DATASET } from "./swebench-fixtures.js";

describe("swebench dataset", () => {
  it("parses the full dataset file, keeping only the fields the adapter reads", () => {
    const list = parseDataset(SYNTHETIC_DATASET);
    expect(list).toHaveLength(2);
    const first = list[0];
    expect(first).toEqual({
      instance_id: "acme__widget-101",
      repo: "acme/widget",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      problem_statement: "Widget.size returns the wrong value for an empty widget.",
    });
    // Unused columns (patch, test_patch, FAIL_TO_PASS, ...) are stripped, not retained.
    expect(Object.keys(first ?? {})).toEqual([
      "instance_id",
      "repo",
      "base_commit",
      "problem_statement",
    ]);
  });

  it("rejects a non-40-hex base_commit", () => {
    const bad = JSON.stringify([
      {
        instance_id: "acme__widget-101",
        repo: "acme/widget",
        base_commit: "not-a-sha",
        problem_statement: "x",
      },
    ]);
    expect(() => parseDataset(bad)).toThrow(/base_commit/);
  });

  it("rejects a repo that is not owner/name", () => {
    const bad = JSON.stringify([
      {
        instance_id: "acme__widget-101",
        repo: "justname",
        base_commit: "0123456789abcdef0123456789abcdef01234567",
        problem_statement: "x",
      },
    ]);
    expect(() => parseDataset(bad)).toThrow(/owner\/name/);
  });

  it("selectSubset returns rows in curated order", () => {
    const all = parseDataset(SYNTHETIC_DATASET);
    const picked = selectSubset(all, ["acme__gadget-7", "acme__widget-101"]);
    expect(picked.map((i) => i.instance_id)).toEqual(["acme__gadget-7", "acme__widget-101"]);
  });

  it("selectSubset throws loudly on an id missing from the dataset", () => {
    const all = parseDataset(SYNTHETIC_DATASET);
    expect(() => selectSubset(all, ["acme__widget-101", "ghost__repo-1"])).toThrow(
      /curated instance_id not found in dataset: ghost__repo-1/,
    );
  });
});

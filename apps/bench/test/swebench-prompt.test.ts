import { describe, expect, it } from "vitest";
import type { SweInstance } from "../src/adapters/swebench/dataset.js";
import { buildPrompt } from "../src/adapters/swebench/prompt.js";

const inst: SweInstance = {
  instance_id: "acme__widget-101",
  repo: "acme/widget",
  base_commit: "0123456789abcdef0123456789abcdef01234567",
  problem_statement: "Widget.size returns the wrong value for an empty widget.",
};

describe("swebench prompt", () => {
  it("includes the issue text, repo, and base commit", () => {
    const prompt = buildPrompt(inst);
    expect(prompt).toContain(inst.problem_statement);
    expect(prompt).toContain("acme/widget");
    expect(prompt).toContain(inst.base_commit);
  });

  it("instructs the agent not to edit test files", () => {
    expect(buildPrompt(inst).toLowerCase()).toContain("do not edit");
  });

  it("does not leak grader-only artifacts", () => {
    const prompt = buildPrompt(inst);
    // The prompt is built from a SweInstance that structurally has no gold/test patch; assert nothing
    // resembling the oracle slipped in regardless.
    expect(prompt).not.toContain("FAIL_TO_PASS");
    expect(prompt).not.toContain("diff --git");
  });
});

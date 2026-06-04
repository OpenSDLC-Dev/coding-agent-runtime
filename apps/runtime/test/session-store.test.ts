import { describe, expect, it } from "vitest";
import { extractChangedFiles, SessionRegistry } from "../src/agent/session-store.js";

function fixedClock(start = 1000): () => number {
  let t = start;
  return () => (t += 1);
}

describe("SessionRegistry", () => {
  it("creates a record on first turn and increments turns on subsequent turns", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "MiniMax-M3", abortController: new AbortController() });
    let rec = reg.get("s1");
    expect(rec?.turns).toBe(1);
    expect(rec?.status).toBe("running");
    expect(rec?.model).toBe("MiniMax-M3");
    reg.finishTurn("s1", "idle");
    reg.startTurn("s1", { model: undefined, abortController: new AbortController() });
    rec = reg.get("s1");
    expect(rec?.turns).toBe(2);
    expect(rec?.status).toBe("running");
  });

  it("accumulates usage and cost across turns", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "m", abortController: new AbortController() });
    reg.recordResult("s1", { inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
    reg.recordResult("s1", { inputTokens: 5, outputTokens: 7, costUsd: 0.02 });
    const rec = reg.get("s1");
    expect(rec?.inputTokens).toBe(15);
    expect(rec?.outputTokens).toBe(27);
    expect(rec?.totalCostUsd).toBeCloseTo(0.03);
  });

  it("dedupes changed files", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "m", abortController: new AbortController() });
    reg.trackChangedFiles("s1", ["/workspace/a.txt", "/workspace/a.txt", "/workspace/b.txt"]);
    expect(reg.get("s1")?.changedFiles).toEqual(["/workspace/a.txt", "/workspace/b.txt"]);
  });

  it("abort() aborts the active controller, marks aborted, and returns false when nothing active", () => {
    const reg = new SessionRegistry(fixedClock());
    const ac = new AbortController();
    reg.startTurn("s1", { model: "m", abortController: ac });
    expect(reg.abort("s1")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(reg.get("s1")?.status).toBe("aborted");
    expect(reg.abort("s1")).toBe(false);
    expect(reg.abort("nope")).toBe(false);
  });

  it("finishTurn does not overwrite a non-running status", () => {
    const reg = new SessionRegistry(fixedClock());
    const ac = new AbortController();
    reg.startTurn("s1", { model: "m", abortController: ac });
    reg.abort("s1"); // status -> aborted
    reg.finishTurn("s1", "error");
    expect(reg.get("s1")?.status).toBe("aborted");
  });

  it("list/has/remove behave", () => {
    const reg = new SessionRegistry(fixedClock());
    reg.startTurn("s1", { model: "m", abortController: new AbortController() });
    reg.startTurn("s2", { model: "m", abortController: new AbortController() });
    expect(reg.has("s1")).toBe(true);
    expect(
      reg
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["s1", "s2"]);
    reg.remove("s1");
    expect(reg.has("s1")).toBe(false);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("extractChangedFiles", () => {
  it("pulls file paths from edit-family tool uses only", () => {
    const files = extractChangedFiles([
      { name: "Write", input: { file_path: "/workspace/a.txt" } },
      { name: "Edit", input: { file_path: "/workspace/b.txt" } },
      { name: "NotebookEdit", input: { notebook_path: "/workspace/n.ipynb" } },
      { name: "Bash", input: { command: "ls" } },
      { name: "Read", input: { file_path: "/workspace/c.txt" } },
    ]);
    expect(files).toEqual(["/workspace/a.txt", "/workspace/b.txt", "/workspace/n.ipynb"]);
  });
});

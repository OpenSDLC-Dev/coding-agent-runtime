import { describe, expect, it } from "vitest";
import type { Message, ToolMessage } from "../types";
import { applyToolResults, formatToolResultContent } from "./tool-result";

const runningTool = (toolUseId: string, name = "Bash"): ToolMessage => ({
  id: `m_${toolUseId}`,
  kind: "tool",
  name,
  input: null,
  status: "running",
  result: null,
  toolUseId,
});

describe("formatToolResultContent", () => {
  it("returns a string payload as-is", () => {
    expect(formatToolResultContent("a.txt")).toBe("a.txt");
  });
  it("JSON-stringifies a structured payload", () => {
    expect(formatToolResultContent([{ type: "text", text: "hi" }])).toContain('"text": "hi"');
  });
  it("returns null when content is absent", () => {
    expect(formatToolResultContent(null)).toBeNull();
    expect(formatToolResultContent(undefined)).toBeNull();
  });
});

describe("applyToolResults", () => {
  it("resolves the running tool matched by toolUseId and fills its result", () => {
    const messages: Message[] = [runningTool("tu-1")];
    const next = applyToolResults(messages, [
      { toolUseId: "tu-1", isError: false, content: "a.txt" },
    ]);
    const tool = next[0] as ToolMessage;
    expect(tool.status).toBe("done");
    expect(tool.result).toBe("a.txt");
  });

  it("matches each result to its own tool when several run in parallel", () => {
    const messages: Message[] = [runningTool("tu-1"), runningTool("tu-2")];
    const next = applyToolResults(messages, [
      { toolUseId: "tu-2", isError: false, content: "second" },
      { toolUseId: "tu-1", isError: false, content: "first" },
    ]);
    expect((next[0] as ToolMessage).result).toBe("first");
    expect((next[1] as ToolMessage).result).toBe("second");
  });

  it("falls back to the oldest running tool when the result carries no toolUseId", () => {
    const messages: Message[] = [runningTool("tu-1")];
    const next = applyToolResults(messages, [{ isError: false, content: "x" }]);
    expect((next[0] as ToolMessage).status).toBe("done");
    expect((next[0] as ToolMessage).result).toBe("x");
  });

  it("leaves tools running when a present toolUseId matches nothing (fail-safe)", () => {
    const messages: Message[] = [runningTool("tu-1")];
    const next = applyToolResults(messages, [{ toolUseId: "tu-unknown", content: "x" }]);
    expect(next).toBe(messages); // unchanged — no wrong tool resolved
    expect((messages[0] as ToolMessage).status).toBe("running");
  });

  it("returns the messages unchanged when there is nothing running to resolve", () => {
    const messages: Message[] = [];
    expect(applyToolResults(messages, [{ toolUseId: "tu-1", content: "x" }])).toBe(messages);
  });
});

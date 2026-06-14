import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineKey } from "../src/config-snapshot.js";
import {
  appendHistory,
  type HistoryEntry,
  HistoryEntrySchema,
  historyEntryFromReport,
  historyPath,
} from "../src/history.js";
import { makeReport } from "./tracking-fixtures.js";

describe("historyEntryFromReport", () => {
  it("captures the key, provenance, and the summary numbers", () => {
    const report = makeReport();
    const e = historyEntryFromReport(report, 777);
    expect(e.at).toBe(777);
    expect(e.key).toBe(baselineKey(report.config));
    expect(e.runtimeVersion).toBe(report.config.runtimeVersion);
    expect(e.resolveRate).toBe(report.summary.resolveRate);
    expect(e.resolved).toBe(report.summary.resolved);
    expect(e.total).toBe(report.summary.total);
  });
});

describe("appendHistory", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per call, creating the file", async () => {
    const e1 = historyEntryFromReport(makeReport(), 1);
    const e2 = historyEntryFromReport(makeReport(), 2);
    await appendHistory(dir, e1);
    await appendHistory(dir, e2);

    const raw = await readFile(historyPath(dir, e1.key), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const parsed: HistoryEntry[] = lines.map((l) => HistoryEntrySchema.parse(JSON.parse(l)));
    expect(parsed.map((p) => p.at)).toEqual([1, 2]); // append order preserved
  });
});

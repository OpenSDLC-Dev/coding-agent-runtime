import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Baseline,
  baselineFromReport,
  baselinePath,
  loadAllBaselines,
  loadBaseline,
  writeBaseline,
} from "../src/baseline.js";
import { baselineKey } from "../src/config-snapshot.js";
import { makeReport, makeSnapshot } from "./tracking-fixtures.js";

describe("baselineFromReport", () => {
  it("derives key/config/summary and stamps acceptedAt", () => {
    const report = makeReport();
    const b = baselineFromReport(report, 12345);
    expect(b.key).toBe(baselineKey(report.config));
    expect(b.config).toEqual(report.config);
    expect(b.summary).toEqual(report.summary);
    expect(b.acceptedAt).toBe(12345);
    expect(b.schemaVersion).toBe(1);
  });
});

describe("baseline persistence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "baselines-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a baseline through write + load", async () => {
    const b = baselineFromReport(makeReport(), 1);
    await writeBaseline(dir, b);
    expect(await loadBaseline(dir, b.key)).toEqual(b);
  });

  it("returns null when no baseline is committed for the key", async () => {
    expect(await loadBaseline(dir, "does-not-exist")).toBeNull();
  });

  it("throws on a malformed baseline file", async () => {
    await writeFile(baselinePath(dir, "broken"), "{ not valid json", "utf8");
    await expect(loadBaseline(dir, "broken")).rejects.toThrow();
  });

  it("rejects a structurally invalid baseline (wrong shape)", async () => {
    await writeFile(baselinePath(dir, "wrong"), JSON.stringify({ schemaVersion: 1 }), "utf8");
    await expect(loadBaseline(dir, "wrong")).rejects.toThrow();
  });

  it("loadAllBaselines returns [] for a missing dir and sorted baselines otherwise", async () => {
    expect(await loadAllBaselines(join(dir, "nope"))).toEqual([]);
    const a = baselineFromReport(makeReport({ config: makeSnapshot({ backendLabel: "aaa" }) }), 1);
    const z = baselineFromReport(makeReport({ config: makeSnapshot({ backendLabel: "zzz" }) }), 2);
    await writeBaseline(dir, z);
    await writeBaseline(dir, a);
    const all = await loadAllBaselines(dir);
    expect(all.map((b: Baseline) => b.key)).toEqual([a.key, z.key].sort());
  });
});

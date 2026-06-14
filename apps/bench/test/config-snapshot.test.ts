import { describe, expect, it } from "vitest";
import {
  baselineKey,
  buildSnapshot,
  type ConfigSnapshot,
  subsetHash,
} from "../src/config-snapshot.js";
import { makeSnapshot } from "./tracking-fixtures.js";

describe("buildSnapshot", () => {
  it("maps the /config response and run params into the tuple", () => {
    const snap = buildSnapshot({
      benchmark: "swe-bench",
      datasetSplit: "lite-curated",
      instanceIds: ["b", "a"],
      backendLabel: "minimax-m3",
      model: "MiniMax-M3",
      config: { defaultModel: "MiniMax-M3", version: "0.9.0", effort: "high", maxTurns: 50 },
      harnessVersion: "0.9.0",
    });
    expect(snap.benchmark).toBe("swe-bench");
    expect(snap.datasetSplit).toBe("lite-curated");
    expect(snap.backendLabel).toBe("minimax-m3");
    expect(snap.model).toBe("MiniMax-M3");
    expect(snap.effort).toBe("high"); // taken from /config, not guessed
    expect(snap.maxTurns).toBe(50);
    expect(snap.runtimeVersion).toBe("0.9.0");
    expect(snap.harnessVersion).toBe("0.9.0");
    expect(snap.promptScaffoldVersion).toBe("1"); // default
    expect(snap.subsetHash).toBe(subsetHash(["a", "b"]));
  });
});

describe("subsetHash", () => {
  it("is order-independent (same set of ids -> same hash)", () => {
    expect(subsetHash(["a", "b", "c"])).toBe(subsetHash(["c", "a", "b"]));
  });

  it("changes when the set of ids changes", () => {
    expect(subsetHash(["a", "b"])).not.toBe(subsetHash(["a", "b", "c"]));
  });
});

describe("baselineKey", () => {
  it("is deterministic and filename-safe", () => {
    const snap = makeSnapshot();
    expect(baselineKey(snap)).toBe(baselineKey(snap));
    expect(baselineKey(snap)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("ignores provenance fields (runtimeVersion / harnessVersion) -- cross-version by design", () => {
    const base = makeSnapshot();
    expect(baselineKey(makeSnapshot({ runtimeVersion: "9.9.9" }))).toBe(baselineKey(base));
    expect(baselineKey(makeSnapshot({ harnessVersion: "9.9.9" }))).toBe(baselineKey(base));
  });

  it("changes when any eval-config identity field changes", () => {
    const base = baselineKey(makeSnapshot());
    const identityChanges: Partial<ConfigSnapshot>[] = [
      { benchmark: "swe-bench" },
      { datasetSplit: "other" },
      { subsetHash: "0000000000000000" },
      { backendLabel: "other-backend" },
      { model: "other-model" },
      { effort: "low" },
      { maxTurns: 7 },
      { promptScaffoldVersion: "2" },
    ];
    for (const change of identityChanges) {
      expect(baselineKey(makeSnapshot(change)), JSON.stringify(change)).not.toBe(base);
    }
  });

  it("embeds a human-navigable prefix from backend + benchmark", () => {
    const key = baselineKey(makeSnapshot({ backendLabel: "MiniMax M3", benchmark: "swe-bench" }));
    expect(key.startsWith("minimax-m3-swe-bench-")).toBe(true);
  });
});

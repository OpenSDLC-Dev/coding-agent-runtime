import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineFromReport } from "../src/baseline.js";
import { applyTracking, parseArgs } from "../src/cli.js";
import { baselineKey } from "../src/config-snapshot.js";
import { renderBenchmarks } from "../src/report/markdown.js";
import { makeReport, makeSummary } from "./tracking-fixtures.js";

describe("parseArgs", () => {
  it("detects the emit-markdown command, with or without a leading --", () => {
    // scripts/bench.mjs forwards a "--" that can land as argv[0]; the command must still be seen.
    expect(parseArgs(["emit-markdown"]).command).toBe("emit-markdown");
    expect(parseArgs(["--", "emit-markdown"]).command).toBe("emit-markdown");
  });

  it("defaults to the run command when the first token is a flag or absent", () => {
    expect(parseArgs(["--benchmark", "hello-bench"]).command).toBe("run");
    expect(parseArgs([]).command).toBe("run");
  });

  it("parses boolean tracking flags and the backend label", () => {
    const a = parseArgs(["--compare", "--accept", "--backend-label", "minimax-m3"]);
    expect(a.compare).toBe(true);
    expect(a.accept).toBe(true);
    expect(a.updateHistory).toBe(false);
    expect(a.emitMarkdown).toBe(false);
    expect(a.backendLabel).toBe("minimax-m3");
    expect(parseArgs([]).backendLabel).toBe("unknown");
  });
});

describe("applyTracking", () => {
  let dir: string;
  // Build args with all tracking paths pointed into a tmp dir, so the test never touches the repo.
  const argsFor = (extra: string[]) =>
    parseArgs([
      ...extra,
      "--baseline-dir",
      join(dir, "baselines"),
      "--history-dir",
      join(dir, "history"),
      "--benchmarks-out",
      join(dir, "BENCHMARKS.md"),
    ]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cli-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("--accept writes the baseline, and a matching --compare then passes (exit 0)", async () => {
    const report = makeReport();
    expect(await applyTracking(report, argsFor(["--accept"]))).toBe(0);
    expect(await applyTracking(report, argsFor(["--compare"]))).toBe(0);
  });

  it("--compare exits non-zero when the resolve rate drops below the committed baseline", async () => {
    await applyTracking(makeReport(), argsFor(["--accept"])); // baseline pinned at 0.6
    const worse = makeReport({ summary: makeSummary({ resolved: 1, resolveRate: 0.2 }) });
    expect(await applyTracking(worse, argsFor(["--compare"]))).toBe(1);
  });

  it("--compare with no committed baseline is 'new' (exit 0)", async () => {
    expect(await applyTracking(makeReport(), argsFor(["--compare"]))).toBe(0);
  });

  it("--emit-markdown writes BENCHMARKS.md generated from the committed baselines", async () => {
    const report = makeReport();
    await applyTracking(report, argsFor(["--accept", "--emit-markdown"]));
    const md = await readFile(join(dir, "BENCHMARKS.md"), "utf8");
    expect(md).toBe(renderBenchmarks([baselineFromReport(report, report.finishedAt)]));
  });

  it("--update-history appends a per-key JSONL line", async () => {
    const report = makeReport();
    await applyTracking(report, argsFor(["--update-history"]));
    const raw = await readFile(join(dir, "history", `${baselineKey(report.config)}.jsonl`), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

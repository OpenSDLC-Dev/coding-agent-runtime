// Pure regression logic: compare a fresh run against the committed baseline for its eval config.
//
// The gate is intentionally narrow: only a drop in resolve rate (beyond an optional tolerance) is a
// regression that fails CI. Cost and turn-count deltas are reported for visibility but never gate --
// a run that resolves the same fraction more cheaply or slowly is not a correctness regression.

import type { Baseline } from "./baseline.js";
import { baselineKey } from "./config-snapshot.js";
import type { RunReport } from "./report/schema.js";

export type CompareVerdict = "new" | "improve" | "pass" | "regress";

export interface CompareResult {
  verdict: CompareVerdict;
  key: string;
  /** null when there is no committed baseline yet (verdict "new"). */
  baselineRate: number | null;
  currentRate: number;
  /** current - baseline resolve rate (0 when "new"). */
  rateDelta: number;
  /** Reported, not gated. current - baseline. */
  costDelta: number;
  /** Reported, not gated. current - baseline. */
  turnsDelta: number;
  detail: string;
}

export function compare(
  baseline: Baseline | null,
  report: RunReport,
  opts?: { tolerance?: number },
): CompareResult {
  const tolerance = opts?.tolerance ?? 0;
  const key = baselineKey(report.config);
  const currentRate = report.summary.resolveRate;

  if (!baseline) {
    return {
      verdict: "new",
      key,
      baselineRate: null,
      currentRate,
      rateDelta: 0,
      costDelta: 0,
      turnsDelta: 0,
      detail: "no committed baseline for this config; accept this run with --accept to set one",
    };
  }

  const baselineRate = baseline.summary.resolveRate;
  const rateDelta = currentRate - baselineRate;
  const costDelta = report.summary.totalCostUsd - baseline.summary.totalCostUsd;
  const turnsDelta = report.summary.totalTurns - baseline.summary.totalTurns;

  let verdict: CompareVerdict;
  if (rateDelta < -tolerance) verdict = "regress";
  else if (rateDelta > tolerance) verdict = "improve";
  else verdict = "pass";

  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const detail =
    `resolve rate ${pct(currentRate)} vs baseline ${pct(baselineRate)} ` +
    `(${rateDelta >= 0 ? "+" : ""}${pct(rateDelta)}; tolerance ${pct(tolerance)})`;

  return { verdict, key, baselineRate, currentRate, rateDelta, costDelta, turnsDelta, detail };
}

/** A regression is the only failing verdict; everything else (new/improve/pass) is a clean exit. */
export function exitCodeForVerdict(verdict: CompareVerdict): number {
  return verdict === "regress" ? 1 : 0;
}

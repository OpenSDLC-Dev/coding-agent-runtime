// Append-only run history: one JSON line per run, at history/<key>.jsonl, keyed by baselineKey.
//
// This is the durable audit trail of how a config's score moves over time -- independent of whether a
// run was accepted as a baseline. It is write-only here (opt-in via the CLI's --update-history); the
// JSONL is meant to be consumed out of band (plotting, analysis). Each line carries the provenance
// needed to attribute the number to a runtime/harness version.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { baselineKey } from "./config-snapshot.js";
import type { RunReport } from "./report/schema.js";

export const HistoryEntrySchema = z.object({
  /** Epoch ms the run finished. */
  at: z.number(),
  key: z.string(),
  runtimeVersion: z.string(),
  harnessVersion: z.string(),
  resolveRate: z.number(),
  resolved: z.number(),
  total: z.number(),
  totalCostUsd: z.number(),
  totalTurns: z.number(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export function historyPath(dir: string, key: string): string {
  return join(dir, `${key}.jsonl`);
}

export function historyEntryFromReport(report: RunReport, at: number): HistoryEntry {
  return {
    at,
    key: baselineKey(report.config),
    runtimeVersion: report.config.runtimeVersion,
    harnessVersion: report.config.harnessVersion,
    resolveRate: report.summary.resolveRate,
    resolved: report.summary.resolved,
    total: report.summary.total,
    totalCostUsd: report.summary.totalCostUsd,
    totalTurns: report.summary.totalTurns,
  };
}

/** Append one entry as a JSON line, creating the dir/file as needed. */
export async function appendHistory(dir: string, entry: HistoryEntry): Promise<void> {
  HistoryEntrySchema.parse(entry); // validate before touching disk
  await mkdir(dir, { recursive: true });
  await appendFile(historyPath(dir, entry.key), `${JSON.stringify(entry)}\n`, "utf8");
}

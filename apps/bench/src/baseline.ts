// Committed, human-accepted baselines: the "this score is the bar to beat for this eval config".
//
// A baseline is written ONLY by an explicit operator action (the CLI's --accept), never automatically,
// so a baseline always reflects a reviewed decision. It is keyed by the run's baselineKey (the
// eval-config identity), stored at baselines/<key>.json, and carries the full config snapshot so the
// committed file is self-describing.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { baselineKey, ConfigSnapshotSchema } from "./config-snapshot.js";
import { type RunReport, RunSummarySchema } from "./report/schema.js";

export const BaselineSchema = z.object({
  schemaVersion: z.literal(1),
  key: z.string(),
  config: ConfigSnapshotSchema,
  summary: RunSummarySchema,
  /** Epoch ms when an operator accepted this baseline. */
  acceptedAt: z.number(),
});
export type Baseline = z.infer<typeof BaselineSchema>;

export function baselineFromReport(report: RunReport, acceptedAt: number): Baseline {
  return {
    schemaVersion: 1,
    key: baselineKey(report.config),
    config: report.config,
    summary: report.summary,
    acceptedAt,
  };
}

export function baselinePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** The committed baseline for a key, or null if none has been accepted yet. */
export async function loadBaseline(dir: string, key: string): Promise<Baseline | null> {
  let raw: string;
  try {
    raw = await readFile(baselinePath(dir, key), "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return BaselineSchema.parse(JSON.parse(raw));
}

export async function writeBaseline(dir: string, baseline: Baseline): Promise<void> {
  BaselineSchema.parse(baseline); // validate before touching disk
  await mkdir(dir, { recursive: true });
  await writeFile(
    baselinePath(dir, baseline.key),
    `${JSON.stringify(baseline, null, 2)}\n`,
    "utf8",
  );
}

/** All committed baselines, sorted by key, for rendering BENCHMARKS.md. Missing dir -> empty. */
export async function loadAllBaselines(dir: string): Promise<Baseline[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const baselines: Baseline[] = [];
  for (const name of names.sort()) {
    baselines.push(BaselineSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8"))));
  }
  return baselines;
}

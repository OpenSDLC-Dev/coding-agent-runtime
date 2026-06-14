// The config tuple a run is identified by, and the baseline key derived from it.
//
// A benchmark number is only meaningful next to the configuration that produced it. So every run
// snapshots a tuple -- what benchmark, on which instances, against which backend, at what effort, with
// which prompt scaffold -- and embeds it in the RunReport. The baseline key is the *eval-config
// identity* subset of that tuple: it deliberately EXCLUDES the runtime/harness versions, so a newer
// runtime compares against the same baseline (cross-version regression) while changing the model,
// effort, subset, etc. forks a fresh baseline (you are no longer measuring the same thing).
//
// The model-backend URL is never read here: the runtime deliberately does not expose it, so the
// operator names the backend with --backend-label instead.

import { createHash } from "node:crypto";
import { z } from "zod";

// Bump when the prompt scaffolding (task prompt templates) changes materially: it is part of the
// eval-config identity, so a scaffold change should fork a new baseline rather than silently shift the
// score under an existing one.
export const PROMPT_SCAFFOLD_VERSION = "1";

// The subset of GET /config the harness records. Tolerant of extra fields (zod strips unknowns), so
// adding fields to /config never breaks snapshotting.
export const RuntimeConfigResponseSchema = z.object({
  defaultModel: z.string().nullable(),
  version: z.string(),
  effort: z.string(),
  maxTurns: z.number(),
});
export type RuntimeConfigResponse = z.infer<typeof RuntimeConfigResponseSchema>;

export const ConfigSnapshotSchema = z.object({
  // --- eval-config identity (these define the baseline key) ---
  benchmark: z.string(),
  datasetSplit: z.string(),
  subsetHash: z.string(),
  backendLabel: z.string(),
  model: z.string(),
  effort: z.string(),
  maxTurns: z.number(),
  promptScaffoldVersion: z.string(),
  // --- provenance (recorded, but NOT part of the key) ---
  runtimeVersion: z.string(),
  harnessVersion: z.string(),
});
export type ConfigSnapshot = z.infer<typeof ConfigSnapshotSchema>;

// A stable, order-independent fingerprint of the instance set actually run, so reordering or
// regenerating the subset list does not change the key, but adding/removing an instance does.
export function subsetHash(instanceIds: readonly string[]): string {
  const canonical = JSON.stringify([...instanceIds].sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export interface SnapshotInput {
  benchmark: string;
  datasetSplit: string;
  instanceIds: readonly string[];
  backendLabel: string;
  /** The model that actually ran (the --model value, else the runtime's defaultModel, else "default"). */
  model: string;
  config: RuntimeConfigResponse;
  harnessVersion: string;
  promptScaffoldVersion?: string;
}

export function buildSnapshot(input: SnapshotInput): ConfigSnapshot {
  return {
    benchmark: input.benchmark,
    datasetSplit: input.datasetSplit,
    subsetHash: subsetHash(input.instanceIds),
    backendLabel: input.backendLabel,
    model: input.model,
    effort: input.config.effort,
    maxTurns: input.config.maxTurns,
    promptScaffoldVersion: input.promptScaffoldVersion ?? PROMPT_SCAFFOLD_VERSION,
    runtimeVersion: input.config.version,
    harnessVersion: input.harnessVersion,
  };
}

// Lowercase, replace any run of non-alphanumerics with a single dash, trim dashes. Keeps the key
// filename-safe and human-navigable (it becomes baselines/<key>.json).
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

export function baselineKey(s: ConfigSnapshot): string {
  // A canonical JSON array (fixed field order) is unambiguous for any field content -- no separator a
  // value could forge. runtimeVersion/harnessVersion are intentionally absent: that is what makes this
  // a cross-version baseline key rather than a per-build one.
  const canonical = JSON.stringify([
    s.benchmark,
    s.datasetSplit,
    s.subsetHash,
    s.backendLabel,
    s.model,
    s.effort,
    s.maxTurns,
    s.promptScaffoldVersion,
  ]);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug(s.backendLabel)}-${slug(s.benchmark)}-${hash}`;
}

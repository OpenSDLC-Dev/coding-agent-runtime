// The run-report schema is the versioned, validated output of a benchmark run. Following the
// runtime's convention, zod is the single source of truth: the runner validates on the way out so a
// malformed report fails loudly rather than producing a misleading number. Every report embeds the
// `config` tuple that produced it (see config-snapshot.ts), so the artifact is self-describing and the
// baseline/regression machinery can key off it.

import { z } from "zod";
import { ConfigSnapshotSchema } from "../config-snapshot.js";

export const InstanceStatus = z.enum(["resolved", "unresolved", "errored", "timeout"]);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

export const InstanceResultSchema = z.object({
  instanceId: z.string(),
  status: InstanceStatus,
  turns: z.number().min(0),
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  costUsd: z.number().min(0),
  wallTimeMs: z.number().min(0),
  sessionId: z.string().nullable(),
  traceId: z.string().nullable(),
  error: z.string().optional(),
});
export type InstanceResult = z.infer<typeof InstanceResultSchema>;

export const RunSummarySchema = z.object({
  total: z.number().min(0),
  resolved: z.number().min(0),
  unresolved: z.number().min(0),
  errored: z.number().min(0),
  resolveRate: z.number().min(0).max(1),
  totalCostUsd: z.number().min(0),
  totalInputTokens: z.number().min(0),
  totalOutputTokens: z.number().min(0),
  totalTurns: z.number().min(0),
  wallTimeMs: z.number().min(0),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunReportSchema = z.object({
  // v2 adds the embedded `config` tuple. v1 reports (no config) intentionally fail to parse — the
  // benchmark subsystem is unreleased, so there are no v1 artifacts to keep readable.
  schemaVersion: z.literal(2),
  benchmark: z.string(),
  config: ConfigSnapshotSchema,
  startedAt: z.number(),
  finishedAt: z.number(),
  summary: RunSummarySchema,
  instances: z.array(InstanceResultSchema),
});
export type RunReport = z.infer<typeof RunReportSchema>;

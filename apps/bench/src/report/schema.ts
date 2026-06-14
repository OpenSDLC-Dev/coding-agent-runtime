// The run-report schema is the versioned, validated output of a benchmark run. Following the
// runtime's convention, zod is the single source of truth: the runner validates on the way out so a
// malformed report fails loudly rather than producing a misleading number. The config tuple
// (model backend / effort / scaffold version) is intentionally deferred to a later milestone.

import { z } from "zod";

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
  schemaVersion: z.literal(1),
  benchmark: z.string(),
  startedAt: z.number(),
  finishedAt: z.number(),
  summary: RunSummarySchema,
  instances: z.array(InstanceResultSchema),
});
export type RunReport = z.infer<typeof RunReportSchema>;

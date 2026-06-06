export type SessionStatus = "running" | "idle" | "error" | "aborted";

export interface SessionRecord {
  id: string;
  model: string | undefined;
  status: SessionStatus;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  changedFiles: string[];
  createdAt: number;
  lastActiveAt: number;
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Best effort: extract changed file paths from the input of edit-type tool_use calls.
export function extractChangedFiles(
  toolUses: ReadonlyArray<{ name: string; input: unknown }>,
): string[] {
  const files: string[] = [];
  for (const t of toolUses) {
    if (!EDIT_TOOLS.has(t.name)) continue;
    const input = t.input as { file_path?: unknown; notebook_path?: unknown } | null;
    const p =
      typeof input?.file_path === "string"
        ? input.file_path
        : typeof input?.notebook_path === "string"
          ? input.notebook_path
          : undefined;
    if (p) files.push(p);
  }
  return files;
}

// In-process session registry: a runtime-state view (turns/cumulative usage/cost/status/changed files + the active turn's AbortController).
// The container is stateless — the durable source of truth is the transcript on the mounted disk; this table is a runtime convenience, and losing it on restart is acceptable.
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  startTurn(
    id: string,
    opts: { model: string | undefined; abortController: AbortController },
  ): void {
    const t = this.now();
    const existing = this.sessions.get(id);
    if (existing) {
      existing.status = "running";
      existing.turns += 1;
      existing.lastActiveAt = t;
      if (opts.model) existing.model = opts.model;
    } else {
      this.sessions.set(id, {
        id,
        model: opts.model,
        status: "running",
        turns: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        changedFiles: [],
        createdAt: t,
        lastActiveAt: t,
      });
    }
    this.active.set(id, opts.abortController);
  }

  recordResult(
    id: string,
    r: { inputTokens: number; outputTokens: number; costUsd: number },
  ): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.totalCostUsd += r.costUsd;
    s.lastActiveAt = this.now();
  }

  trackChangedFiles(id: string, files: string[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const f of files) if (!s.changedFiles.includes(f)) s.changedFiles.push(f);
  }

  finishTurn(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id);
    if (s && s.status === "running") s.status = status;
    this.active.delete(id);
  }

  abort(id: string): boolean {
    const ac = this.active.get(id);
    if (!ac) return false;
    ac.abort();
    const s = this.sessions.get(id);
    if (s) s.status = "aborted";
    this.active.delete(id);
    return true;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.active.delete(id);
  }
}

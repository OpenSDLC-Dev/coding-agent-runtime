// Domain model for the playground. Sessions live client-side (the runtime has no
// "list sessions" endpoint); each session's turns stream from the live runtime.

export type SessionStatus = "idle" | "running" | "stopped" | "error";

export interface ChangedFile {
  path: string;
  action: string; // "created" | "edited" | …
}

export interface UserMessage {
  id: string;
  kind: "user";
  text: string;
}
export interface AssistantMessage {
  id: string;
  kind: "assistant";
  text: string;
}
export interface ToolMessage {
  id: string;
  kind: "tool";
  name: string;
  input: Record<string, unknown> | null;
  status: "running" | "done";
  result: string | null;
  toolUseId?: string; // SDK tool_use id; links a tool_result back to its call
}
export interface ResultMessage {
  id: string;
  kind: "result";
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}
export interface SystemMessage {
  id: string;
  kind: "system";
  text: string;
  error?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolMessage | ResultMessage | SystemMessage;

export interface Session {
  id: string; // client id (used for keys + display until the runtime assigns one)
  realId?: string; // sessionId from the runtime's `init` event; used for follow-up turns
  title: string;
  status: SessionStatus;
  model: string;
  created: string; // relative label, e.g. "just now"
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  traceId: string | null;
  changedFiles: ChangedFile[];
  messages: Message[];
}

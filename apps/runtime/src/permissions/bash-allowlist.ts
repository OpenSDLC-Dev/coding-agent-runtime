import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

// Default allowed commands (matched against the basename of argv[0]).
// gh/git/npm/uv etc. are "intentional network egress points" (spec §6); curl/wget/sudo/sh/bash/eval/xargs are deliberately excluded.
export const DEFAULT_BASH_ALLOWLIST: readonly string[] = [
  "git",
  "gh",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "uv",
  "uvx",
  "pip",
  "pip3",
  "ls",
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "find",
  "wc",
  "echo",
  "pwd",
  "cd",
  "mkdir",
  "mv",
  "cp",
  "rm",
  "touch",
  "chmod",
  "test",
  "true",
  "false",
  "which",
  "dirname",
  "basename",
  "realpath",
  "stat",
  "diff",
  "tee",
  "sort",
  "uniq",
  "cut",
  "tr",
  "sed",
  "awk",
  "jq",
  "sleep",
  "date",
];

// Command wrappers: only after stripping them (and their option/numeric-argument prefixes) do we reach the real argv[0].
const WRAPPERS = new Set([
  "timeout",
  "nice",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
  "exec",
  "time",
  "env",
]);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NUM_OR_DURATION = /^\d+(\.\d+)?[smhd]?$/;

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

// Split a shell command line into sub-command fragments at control operators that are NOT inside quotes.
// Split points: newline, ; & | (including && || |&), and sub-shell / command-substitution boundaries ( ) $( ` .
// Inside single quotes everything is literal; inside double quotes operators are not split, but command substitution / backticks still apply (we split inside double quotes too).
export function splitCommands(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
        cur += next;
        i++;
        continue;
      }
      if (c === '"') {
        inDouble = false;
        continue;
      }
      if (c === "`") {
        push();
        continue;
      }
      if (c === "$" && next === "(") {
        push();
        i++;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "\\") {
      if (next !== undefined) {
        cur += next;
        i++;
      }
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "`") {
      push();
      continue;
    }
    if (c === "$" && next === "(") {
      push();
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      push();
      continue;
    }
    if (c === "\n" || c === ";") {
      push();
      continue;
    }
    if (c === ">" || c === "<") {
      // Redirection operators (e.g. `2>&1`, `>&2`, `>>out`, `> file`): keep them verbatim in the fragment,
      // and consume any following `>` (>>) and `&` (>&) so the `&` in `>&` does not trigger a background/control split.
      cur += c;
      let j = i + 1;
      if (command[j] === c) {
        cur += command[j];
        j++;
      }
      if (command[j] === "&") {
        cur += command[j];
        j++;
      }
      i = j - 1;
      continue;
    }
    if (c === "&") {
      // `&>` (and `&>>`) is a redirection, not a background operator: do not split, keep `&` verbatim, and let the branch above handle the `>`.
      if (next === ">") {
        cur += c;
        continue;
      }
      push();
      if (next === "&") i++;
      continue;
    }
    if (c === "|") {
      push();
      if (next === "|" || next === "&") i++;
      continue;
    }
    cur += c;
  }
  push();
  return out;
}

// Split a sub-command fragment into words (by whitespace, respecting quotes and stripping them).
function tokenize(sub: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let inSingle = false;
  let inDouble = false;
  const push = () => {
    if (has) words.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < sub.length; i++) {
    const c = sub[i];
    const next = sub[i + 1];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else {
        cur += c;
        has = true;
      }
      continue;
    }
    if (inDouble) {
      if (c === "\\" && (next === '"' || next === "\\")) {
        cur += next;
        has = true;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      else {
        cur += c;
        has = true;
      }
      continue;
    }
    if (c === "\\") {
      if (next !== undefined) {
        cur += next;
        has = true;
        i++;
      }
      continue;
    }
    if (c === "'") {
      inSingle = true;
      has = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      has = true;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return words;
}

// Resolve the real executable name (basename) from a sub-command fragment; returns undefined when empty / only environment assignments.
export function resolveExecutable(sub: string): string | undefined {
  let words = tokenize(sub);
  for (;;) {
    while (words.length > 0 && ENV_ASSIGN.test(words[0] as string)) words = words.slice(1);
    if (words.length === 0) return undefined;
    const head = basename(words[0] as string);
    if (WRAPPERS.has(head)) {
      words = words.slice(1);
      while (
        words.length > 0 &&
        ((words[0] as string).startsWith("-") ||
          NUM_OR_DURATION.test(words[0] as string) ||
          ENV_ASSIGN.test(words[0] as string))
      ) {
        words = words.slice(1);
      }
      continue;
    }
    return head;
  }
}

export interface BashCheckResult {
  allowed: boolean;
  offending?: string;
  reason?: string;
}

// Validate the whole command: reject if any sub-command's argv[0] is not in the allowlist.
export function checkBashCommand(command: string, allow: ReadonlySet<string>): BashCheckResult {
  for (const sub of splitCommands(command)) {
    const exe = resolveExecutable(sub);
    if (exe === undefined) continue;
    if (!allow.has(exe)) {
      return {
        allowed: false,
        offending: exe,
        reason: `Bash command \`${exe}\` is not in the allowlist. Allowed commands: ${[...allow].join(", ")}. To permit it, configure RUNTIME_BASH_ALLOWLIST.`,
      };
    }
  }
  return { allowed: true };
}

// PreToolUse hook factory: only intercepts Bash; deny when not in the allowlist (bypasses canUseTool, blocks even under bypassPermissions).
export function createBashAllowlistHook(allowlist: readonly string[]): HookCallback {
  const allow = new Set(allowlist);
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const i = input as PreToolUseHookInput;
    if (i.tool_name !== "Bash") return {};
    const command = (i.tool_input as { command?: unknown } | null)?.command;
    if (typeof command !== "string") return {};
    const res = checkBashCommand(command, allow);
    if (res.allowed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: res.reason ?? `Command not in allowlist: ${res.offending ?? "?"}`,
      },
    };
  };
}

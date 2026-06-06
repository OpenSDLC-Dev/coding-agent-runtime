import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

// 默认允许的命令（匹配 argv[0] 的 basename）。
// gh/git/npm/uv 等是“有意出网口”（spec §6）；curl/wget/sudo/sh/bash/eval/xargs 故意不在内。
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

// 命令包装器：剥掉它们（及其选项/数值参数前缀）后才是真正的 argv[0]。
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

// 把一条 shell 命令行按【未被引号包裹】的控制运算符拆成子命令片段。
// 拆分点：换行、; & |（含 && || |&）、子shell/命令替换边界 ( ) $( ` 。
// 单引号内一切原义；双引号内运算符不拆，但命令替换/反引号仍有效（在双引号内也拆）。
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
    if (c === "&") {
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

// 把一个子命令片段切成词（按空白，尊重引号、剥引号）。
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

// 从子命令片段解析真正的可执行名（basename）；空 / 仅环境赋值返回 undefined。
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

// 校验整条命令：任一子命令的 argv[0] 不在白名单即拒绝。
export function checkBashCommand(command: string, allow: ReadonlySet<string>): BashCheckResult {
  for (const sub of splitCommands(command)) {
    const exe = resolveExecutable(sub);
    if (exe === undefined) continue;
    if (!allow.has(exe)) {
      return {
        allowed: false,
        offending: exe,
        reason: `Bash 命令 \`${exe}\` 不在白名单内。允许的命令：${[...allow].join(", ")}。如需放开，配置 RUNTIME_BASH_ALLOWLIST。`,
      };
    }
  }
  return { allowed: true };
}

// PreToolUse hook 工厂：仅拦 Bash；不在白名单则 deny（绕过 canUseTool、连 bypassPermissions 都拦）。
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
        permissionDecisionReason: res.reason ?? `命令不在白名单：${res.offending ?? "?"}`,
      },
    };
  };
}

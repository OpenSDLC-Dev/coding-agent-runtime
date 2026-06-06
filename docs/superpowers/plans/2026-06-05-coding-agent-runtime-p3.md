# Coding Agent Runtime P3（安全 + 韧性）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已上线的 runtime 补齐安全（解析式 Bash 白名单 + 容器硬化）与韧性（SSE 心跳 + abort 验证），把"越权 bash 被拦并回有意义信息、断线可重连、中止生效"做实。

**Architecture:** 安全靠两层强制——新增 **PreToolUse hook**（解析 `tool_input.command`，拆 `&& || ; | &`/剥包装器/逐子命令查 argv[0]，不在白名单即 `permissionDecision:'deny'`，绕过 canUseTool、连 bypassPermissions 都拦）+ 既有 `disallowedTools` 兜底。容器层用 compose/Dockerfile 的标准硬化集（read-only rootfs + cap_drop + no-new-privileges + 资源限额 + 移除 curl/wget）；egress 以 tool 层为主 + 一份 **opt-in** iptables 脚本 + 威胁模型文档（可信网络前提下的务实选择）。韧性加 `:keepalive` SSE 心跳（事件 `id:` 已有）；abort 链路 P1 已实现，本期补端到端测试。

**Tech Stack:** TypeScript（NodeNext，import 带 `.js`）、Claude Agent SDK 0.3.161（`Options.hooks` PreToolUse）、Hono 4.12 `streamSSE`、vitest 3、Biome、Docker Compose、pnpm（仅经 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 …`）。

---

## 背景与现状（实现者必读）

P0/P1/P2 已合入 `main`。本期改动前的现状（已核实）：

- `apps/runtime/src/agent/runtime.ts`：`runTurn()` 的 `options` 里**已有** `permissionMode:'bypassPermissions'`、`allowDangerouslySkipPermissions:true`、`disallowedTools:["Bash(curl:*)","Bash(wget:*)","Bash(sudo:*)","Bash(rm -rf:*)"]`、`effort`、`abortController`、`pathToClaudeCodeExecutable`（条件）。**没有 `hooks` 字段** —— P3 要加。
- `apps/runtime/src/routes/sessions.ts`：`streamTurn()` 用 `streamSSE`，预读 init 后登记 session 并设 `X-Trace-Id`；catch 里已处理 `abortController.signal.aborted` → 发 `aborted` 事件 + `finishTurn(sid,"aborted")`。**无心跳**。事件已带 `id:`（来自 `SDKMessage.uuid`）。
- `apps/runtime/src/agent/session-store.ts`：`SessionRegistry.abort(id)` **已实现**（取活跃轮 AbortController、`.abort()`、置 `status="aborted"`）。`POST /sessions/:id/stop` → `registry.abort(id)` **已接线**。→ P3 的 "abort 接线" 只需补测试。
- `apps/runtime/Dockerfile`：**已有**非 root 用户（uid/gid 10001 `app`）、`USER app`、目录限定（`/workspace`、`/claude-config`、`/app` 归 app）、`DISABLE_AUTOUPDATER`。构建期用 `curl`（uv 安装）/`wget`（gh keyring），二者仍在运行时镜像里。
- `apps/runtime/container/entrypoint.sh`：启动期写 `${CLAUDE_CONFIG_DIR}/CLAUDE.md`（`/claude-config` 卷，可写）；若有 `GH_TOKEN` 则 `gh auth setup-git`（写**全局 git config** = `~/.gitconfig`）；然后 `exec node`。→ read-only rootfs 下 `~/.gitconfig` 不可写，须用 `GIT_CONFIG_GLOBAL=/tmp/.gitconfig` 重定向。
- `apps/runtime/src/agent/config.ts`：`loadConfig(env)` → `RuntimeConfig`，字段含 `effort`（默认 `"max"`）等。`config.test.ts` 对完整解析用了**全量 `toEqual`**（新增字段必须同步该断言 + `helpers.ts` 的 `testConfig`）。

**已确认的 SDK hook 类型**（`@anthropic-ai/claude-agent-sdk` sdk.d.ts）：
```ts
Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>
interface HookCallbackMatcher { matcher?: string; hooks: HookCallback[]; timeout?: number }
type HookCallback = (input: HookInput, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<HookJSONOutput>
type PreToolUseHookInput = BaseHookInput & { hook_event_name: 'PreToolUse'; tool_name: string; tool_input: unknown; tool_use_id: string }
type PreToolUseHookSpecificOutput = { hookEventName: 'PreToolUse'; permissionDecision?: 'allow'|'deny'|'ask'|'defer'; permissionDecisionReason?: string; ... }
// SyncHookJSONOutput 含 hookSpecificOutput?: PreToolUseHookSpecificOutput | ...
```
deny 返回 `{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason } }`；放行返回 `{}`。**PreToolUse hook 的 deny 绕过 canUseTool**（sdk.d.ts 注释明确：连 bypass 都拦）。

**设计决策（已与用户确认）**：
1. **Egress** = tool 层为主（既有 `disallowedTools` deny curl/wget + 新 PreToolUse 白名单只放受信工具）+ **opt-in** iptables 脚本 + 威胁模型文档。**不**强制容器网络层 egress（明确是对 spec §6 "容器层 egress 白名单" 的务实降级，可信网络前提）。
2. **SSE 韧性** = `:keepalive` 心跳（~20s）+ 事件 id（已有）+ transcript 恢复（文档化）。**不**做 replay buffer / mid-turn 续追。
3. **容器硬化** = 标准集：compose `read_only`+`tmpfs /tmp`+`cap_drop:[ALL]`+`security_opt:[no-new-privileges]`+`pids_limit`+`mem/cpu` 限额；Dockerfile 末层移除 curl/wget + 缓存/配置重定向到 `/tmp`。

**通用命令**（实现者用）：
- 测试：`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test`
- 单文件测试：`… --filter @app/runtime test <file>`（vitest 接受路径过滤）
- 类型：`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck`
- Biome：`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check`（= `biome check --write .`）
- 工作目录始终是仓库根 `C:\Users\HE LE\Project\opensdlc\coding-agent-runtime`。

---

## File Structure

**新建：**
- `apps/runtime/src/permissions/bash-allowlist.ts` —— 命令解析 + 白名单核心（纯函数）+ PreToolUse hook 工厂 + `DEFAULT_BASH_ALLOWLIST`。单一职责：把"一条 shell 命令是否全部由白名单命令组成"判出来，并产出 SDK hook。
- `apps/runtime/test/bash-allowlist.test.ts` —— 解析器/校验器/hook 的单测矩阵。
- `apps/runtime/test/heartbeat.test.ts` —— `startHeartbeat` 的 fake-timer 单测。
- `apps/runtime/container/egress-allowlist.sh` —— **opt-in** iptables egress 收紧脚本（默认 entrypoint 不调用）。
- `docs/superpowers/SECURITY-p3.md` —— 威胁模型 + 两层 Bash 强制 + 硬化 flags + egress 启用方法 + 已知残留。

**修改：**
- `apps/runtime/src/agent/config.ts` —— 加 `bashAllowlist`/`heartbeatMs` 配置。
- `apps/runtime/test/config.test.ts` —— 同步全量 `toEqual` + 新增解析用例。
- `apps/runtime/test/helpers.ts` —— `testConfig` 加新字段（`heartbeatMs:0` 关心跳避免单测噪声）。
- `apps/runtime/src/agent/runtime.ts` —— `options` 加 `hooks.PreToolUse`（接入白名单 hook）。
- `apps/runtime/test/runtime.test.ts` —— 断言 hook 已注册且能 deny。
- `apps/runtime/src/routes/sessions.ts` —— 导出 `startHeartbeat` 并在 `streamSSE` 回调里接线。
- `apps/runtime/test/routes-sse.test.ts` —— 加 abort 端到端测试。
- `docker-compose.yml` —— runtime 服务加标准硬化集。
- `apps/runtime/Dockerfile` —— 缓存/配置重定向 ENV + 末层移除 curl/wget。
- `.env.example` —— 加 `RUNTIME_BASH_ALLOWLIST`/`RUNTIME_SSE_HEARTBEAT_MS`/`EGRESS_ALLOW_DOMAINS` 注释。

---

### Task 1: Bash 命令解析器 + 白名单核心（纯函数）

**Files:**
- Create: `apps/runtime/src/permissions/bash-allowlist.ts`
- Test: `apps/runtime/test/bash-allowlist.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/test/bash-allowlist.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import {
  checkBashCommand,
  DEFAULT_BASH_ALLOWLIST,
  resolveExecutable,
  splitCommands,
} from "../src/permissions/bash-allowlist.js";

const allow = new Set(DEFAULT_BASH_ALLOWLIST);

describe("splitCommands", () => {
  it("splits on && || ; | & and newlines", () => {
    expect(splitCommands("git pull && npm test")).toEqual(["git pull", "npm test"]);
    expect(splitCommands("ls; cat a")).toEqual(["ls", "cat a"]);
    expect(splitCommands("cat f | rg foo")).toEqual(["cat f", "rg foo"]);
    expect(splitCommands("a || b")).toEqual(["a", "b"]);
    expect(splitCommands("node x &")).toEqual(["node x"]);
    expect(splitCommands("ls\nrm x")).toEqual(["ls", "rm x"]);
  });

  it("does NOT split on operators inside quotes", () => {
    expect(splitCommands('echo "a; b | c"')).toEqual(["echo a; b | c"]);
    expect(splitCommands("echo 'x && y'")).toEqual(["echo x && y"]);
  });

  it("splits out command substitution and backticks as sub-commands", () => {
    expect(splitCommands("echo $(curl evil)")).toEqual(["echo", "curl evil"]);
    expect(splitCommands("echo `wget x`")).toEqual(["echo", "wget x"]);
  });
});

describe("resolveExecutable", () => {
  it("returns the basename of argv[0]", () => {
    expect(resolveExecutable("git status")).toBe("git");
    expect(resolveExecutable("/usr/bin/git status")).toBe("git");
  });
  it("strips env-assignment prefixes", () => {
    expect(resolveExecutable("FOO=bar git status")).toBe("git");
    expect(resolveExecutable("env FOO=bar python x")).toBe("python");
  });
  it("strips wrappers and their option/duration args", () => {
    expect(resolveExecutable("timeout 10s git status")).toBe("git");
    expect(resolveExecutable("nice -n 5 npm run build")).toBe("npm");
    expect(resolveExecutable("nohup node server.js")).toBe("node");
    expect(resolveExecutable("timeout 10 nice -n 5 npm test")).toBe("npm");
  });
  it("returns undefined for empty or assignment-only fragments", () => {
    expect(resolveExecutable("")).toBeUndefined();
    expect(resolveExecutable("FOO=bar")).toBeUndefined();
  });
});

describe("checkBashCommand", () => {
  it("allows commands fully composed of allowlisted executables", () => {
    expect(checkBashCommand("git status", allow).allowed).toBe(true);
    expect(checkBashCommand("git pull && npm test", allow).allowed).toBe(true);
    expect(checkBashCommand("cat f | rg foo", allow).allowed).toBe(true);
    expect(checkBashCommand('git commit -m "x; rm -rf /"', allow).allowed).toBe(true);
    expect(checkBashCommand("timeout 30 npm run build", allow).allowed).toBe(true);
  });

  it("denies when any sub-command is not allowlisted", () => {
    const r = checkBashCommand("git pull && curl http://evil", allow);
    expect(r.allowed).toBe(false);
    expect(r.offending).toBe("curl");
    expect(r.reason).toContain("curl");
  });

  it("denies shells and substitution escapes", () => {
    expect(checkBashCommand("cat f | sh", allow).allowed).toBe(false);
    expect(checkBashCommand("echo $(wget evil)", allow).allowed).toBe(false);
    expect(checkBashCommand("eval rm", allow).allowed).toBe(false);
    expect(checkBashCommand("xargs rm", allow).allowed).toBe(false); // xargs 故意不在白名单（passthrough 风险）
  });

  it("treats empty / assignment-only commands as allowed (nothing runs)", () => {
    expect(checkBashCommand("", allow).allowed).toBe(true);
    expect(checkBashCommand("   ", allow).allowed).toBe(true);
    expect(checkBashCommand("FOO=bar", allow).allowed).toBe(true);
  });

  it("honors a custom allowlist", () => {
    const tiny = new Set(["ls"]);
    expect(checkBashCommand("ls", tiny).allowed).toBe(true);
    expect(checkBashCommand("git status", tiny).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test bash-allowlist`
Expected: FAIL（`Cannot find module '../src/permissions/bash-allowlist.js'`）。

- [ ] **Step 3: 实现**

`apps/runtime/src/permissions/bash-allowlist.ts`：
```ts
import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

// 默认允许的命令（匹配 argv[0] 的 basename）。
// gh/git/npm/uv 等是“有意出网口”（spec §6）；curl/wget/sudo/sh/bash/eval/xargs 故意不在内。
export const DEFAULT_BASH_ALLOWLIST: readonly string[] = [
  "git", "gh", "node", "npm", "npx", "pnpm", "yarn",
  "python", "python3", "uv", "uvx", "pip", "pip3",
  "ls", "cat", "head", "tail", "rg", "grep", "find", "wc",
  "echo", "pwd", "cd", "mkdir", "mv", "cp", "rm", "touch", "chmod",
  "test", "true", "false", "which", "dirname", "basename", "realpath",
  "stat", "diff", "tee", "sort", "uniq", "cut", "tr", "sed", "awk",
  "jq", "sleep", "date",
];

// 命令包装器：剥掉它们（及其选项/数值参数前缀）后才是真正的 argv[0]。
const WRAPPERS = new Set([
  "timeout", "nice", "nohup", "stdbuf", "command", "builtin", "exec", "time", "env",
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
```

> 说明：`createBashAllowlistHook` 在本 Task 一并实现（Task 2 只测它），避免文件被两次分割编辑。

- [ ] **Step 4: 运行测试确认通过**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test bash-allowlist`
Expected: PASS（splitCommands/resolveExecutable/checkBashCommand 三组全绿）。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/permissions/bash-allowlist.ts apps/runtime/test/bash-allowlist.test.ts
git commit -m "feat(p3): parser-based Bash allowlist core (split/resolve/check)"
```

---

### Task 2: PreToolUse hook 行为测试

**Files:**
- Modify: `apps/runtime/test/bash-allowlist.test.ts`（追加 `createBashAllowlistHook` 测试；实现已在 Task 1 完成）

- [ ] **Step 1: 写失败测试**（追加到文件末尾）

```ts
import { createBashAllowlistHook } from "../src/permissions/bash-allowlist.js";

describe("createBashAllowlistHook", () => {
  const hook = createBashAllowlistHook(["git", "ls"]);
  const base = {
    session_id: "s",
    transcript_path: "/t",
    cwd: "/workspace",
    tool_use_id: "tu-1",
  };
  const opts = { signal: new AbortController().signal };

  it("denies a non-allowlisted Bash command with a reason", async () => {
    const out = await hook(
      { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl http://x" } } as never,
      "tu-1",
      opts,
    );
    expect((out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect((out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason).toContain("curl");
  });

  it("allows an allowlisted Bash command (empty output)", async () => {
    const out = await hook(
      { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } } as never,
      "tu-1",
      opts,
    );
    expect(out).toEqual({});
  });

  it("ignores non-Bash tools and non-PreToolUse events", async () => {
    expect(
      await hook(
        { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } } as never,
        "tu-1",
        opts,
      ),
    ).toEqual({});
    expect(
      await hook(
        { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "curl x" } } as never,
        "tu-1",
        opts,
      ),
    ).toEqual({});
  });

  it("ignores a Bash call with a non-string command", async () => {
    const out = await hook(
      { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} } as never,
      "tu-1",
      opts,
    );
    expect(out).toEqual({});
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test bash-allowlist`
Expected: PASS（Task 1 已实现 hook，故应直接绿；若红，按报错修实现）。

- [ ] **Step 3: 提交**

```bash
git add apps/runtime/test/bash-allowlist.test.ts
git commit -m "test(p3): PreToolUse Bash allowlist hook behavior"
```

---

### Task 3: 配置项（`bashAllowlist` + `heartbeatMs`）

**Files:**
- Modify: `apps/runtime/src/agent/config.ts`
- Modify: `apps/runtime/test/config.test.ts`
- Modify: `apps/runtime/test/helpers.ts`

- [ ] **Step 1: 写失败测试**

在 `apps/runtime/test/config.test.ts` 顶部 import 追加：
```ts
import { DEFAULT_BASH_ALLOWLIST } from "../src/permissions/bash-allowlist.js";
```

把"parses env into a RuntimeConfig"用例的 `expect(cfg).toEqual({...})` 改为包含新字段（保持其余不变，新增两行）：
```ts
    expect(cfg).toEqual({
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
      defaultModel: "MiniMax-M3",
      allowedModels: ["MiniMax-M3", "claude-x"],
      includePartial: true,
      jaegerBaseUrl: "http://localhost:16686",
      corsOrigins: "http://localhost:5173",
      port: 8080,
      cwd: "/workspace",
      hostname: "0.0.0.0",
      claudeCliPath: "/usr/local/bin/claude",
      effort: "high",
      bashAllowlist: [...DEFAULT_BASH_ALLOWLIST],
      heartbeatMs: 20000,
    });
```

在"applies defaults when optional env is absent"用例末尾追加：
```ts
    expect(cfg.bashAllowlist).toEqual([...DEFAULT_BASH_ALLOWLIST]);
    expect(cfg.heartbeatMs).toBe(20000);
```

在 `describe("loadConfig", …)` 内追加用例：
```ts
  it("parses RUNTIME_BASH_ALLOWLIST (comma/space separated) overriding the default", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_BASH_ALLOWLIST: "git, ls  rg" });
    expect(cfg.bashAllowlist).toEqual(["git", "ls", "rg"]);
  });

  it("falls back to the default allowlist when RUNTIME_BASH_ALLOWLIST is blank", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_BASH_ALLOWLIST: "   " });
    expect(cfg.bashAllowlist).toEqual([...DEFAULT_BASH_ALLOWLIST]);
  });

  it("parses RUNTIME_SSE_HEARTBEAT_MS, allowing 0 to disable", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "5000" }).heartbeatMs).toBe(5000);
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "0" }).heartbeatMs).toBe(0);
  });

  it("falls back to 20000 for an invalid RUNTIME_SSE_HEARTBEAT_MS", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "abc" }).heartbeatMs).toBe(20000);
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-test", RUNTIME_SSE_HEARTBEAT_MS: "-3" }).heartbeatMs).toBe(20000);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test config`
Expected: FAIL（`bashAllowlist`/`heartbeatMs` 未定义 + `toEqual` 不匹配）。同时 `helpers.ts` 的 `testConfig` 缺字段会让其它测试编译报错——下一步一并补。

- [ ] **Step 3: 实现**

`apps/runtime/src/agent/config.ts`：
1. 顶部 import 追加：
```ts
import { DEFAULT_BASH_ALLOWLIST } from "../permissions/bash-allowlist.js";
```
2. `RuntimeConfig` interface 追加两字段：
```ts
  bashAllowlist: string[];
  heartbeatMs: number;
```
3. 在 `loadConfig` 上方加解析器：
```ts
function parseBashAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_BASH_ALLOWLIST];
  const items = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : [...DEFAULT_BASH_ALLOWLIST];
}

function parseHeartbeatMs(raw: string | undefined): number {
  if (raw === undefined) return 20000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 20000;
}
```
4. 在 `loadConfig` 的返回对象里追加：
```ts
    bashAllowlist: parseBashAllowlist(env.RUNTIME_BASH_ALLOWLIST),
    heartbeatMs: parseHeartbeatMs(env.RUNTIME_SSE_HEARTBEAT_MS),
```

`apps/runtime/test/helpers.ts`：
1. 顶部 import 追加：
```ts
import { DEFAULT_BASH_ALLOWLIST } from "../src/permissions/bash-allowlist.js";
```
2. `testConfig` 末尾追加（`heartbeatMs:0` 关心跳，避免单测里起真实定时器）：
```ts
  bashAllowlist: [...DEFAULT_BASH_ALLOWLIST],
  heartbeatMs: 0,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test config`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/agent/config.ts apps/runtime/test/config.test.ts apps/runtime/test/helpers.ts
git commit -m "feat(p3): bashAllowlist + heartbeatMs runtime config"
```

---

### Task 4: 把白名单 hook 接入 `runTurn` options

**Files:**
- Modify: `apps/runtime/src/agent/runtime.ts:114-133`（options 对象）
- Modify: `apps/runtime/test/runtime.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `describe("runTurn", …)` 内）

```ts
  it("registers a PreToolUse Bash allowlist hook in query options", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, testConfig, capturing)) {
      // drain
    }
    const matchers = captured?.hooks?.PreToolUse;
    expect(matchers).toHaveLength(1);
    expect(matchers?.[0]?.matcher).toBe("Bash");
    expect(matchers?.[0]?.hooks).toHaveLength(1);
  });

  it("the registered hook denies a command outside the configured allowlist", async () => {
    let captured: Options | undefined;
    const capturing: QueryFn = (args) => {
      captured = args.options;
      return (async function* () {})();
    };
    for await (const _e of runTurn({ prompt: "hi" }, { ...testConfig, bashAllowlist: ["git"] }, capturing)) {
      // drain
    }
    const hook = captured?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    const out = await hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
        tool_use_id: "t",
        session_id: "s",
        transcript_path: "/t",
        cwd: "/workspace",
      } as never,
      "t",
      { signal: new AbortController().signal },
    );
    expect((out as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test runtime`
Expected: FAIL（`captured.hooks` undefined）。

- [ ] **Step 3: 实现**

`apps/runtime/src/agent/runtime.ts`：
1. 顶部 import 追加：
```ts
import { createBashAllowlistHook } from "../permissions/bash-allowlist.js";
```
2. 在 `options` 对象里、`disallowedTools` 之后加 `hooks`（保留 `disallowedTools` 兜底不动）：
```ts
    // P3 第 1 层：解析式 Bash 白名单（PreToolUse deny 绕过 canUseTool、连 bypass 都拦、覆盖子 agent）。
    // 与上面的 disallowedTools 兜底叠加：deny 永远赢。
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [createBashAllowlistHook(cfg.bashAllowlist)] }],
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test runtime`
Expected: PASS（含既有 telemetry/options 测试不回归）。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/agent/runtime.ts apps/runtime/test/runtime.test.ts
git commit -m "feat(p3): wire PreToolUse Bash allowlist hook into runTurn"
```

---

### Task 5: SSE 心跳（`:keepalive`）

**Files:**
- Modify: `apps/runtime/src/routes/sessions.ts`（导出 `startHeartbeat` + 在 `streamSSE` 回调接线）
- Create: `apps/runtime/test/heartbeat.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/test/heartbeat.test.ts`：
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "../src/routes/sessions.js";

function fakeStream(over: { aborted?: boolean; closed?: boolean } = {}) {
  const writes: string[] = [];
  return {
    writes,
    aborted: over.aborted ?? false,
    closed: over.closed ?? false,
    write: (s: string) => {
      writes.push(s);
      return Promise.resolve();
    },
  };
}

describe("startHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes a keepalive comment each interval until stopped", () => {
    const s = fakeStream();
    const stop = startHeartbeat(s, 1000);
    vi.advanceTimersByTime(3000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(s.writes).toEqual([": keepalive\n\n", ": keepalive\n\n", ": keepalive\n\n"]);
  });

  it("skips writes while the stream is aborted", () => {
    const s = fakeStream({ aborted: true });
    const stop = startHeartbeat(s, 1000);
    vi.advanceTimersByTime(3000);
    stop();
    expect(s.writes).toHaveLength(0);
  });

  it("is a no-op when interval <= 0 (disabled)", () => {
    const s = fakeStream();
    const stop = startHeartbeat(s, 0);
    vi.advanceTimersByTime(10000);
    stop();
    expect(s.writes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test heartbeat`
Expected: FAIL（`startHeartbeat` 未导出）。

- [ ] **Step 3: 实现**

`apps/runtime/src/routes/sessions.ts`：
1. 在文件靠上处（`streamTurn` 之前）加并导出 helper：
```ts
// SSE 心跳：每 ms 写一条注释行 ": keepalive\n\n"，防反代 idle 断连（spec §4.2/§5）。
// 抽成独立函数便于用 fake timer 单测；整条注释一次性写入（原子块，不与 writeSSE 交错破帧）。
export interface HeartbeatStream {
  readonly aborted: boolean;
  readonly closed: boolean;
  write(input: string): Promise<unknown>;
}

export function startHeartbeat(stream: HeartbeatStream, ms: number): () => void {
  if (ms <= 0) return () => {};
  const timer = setInterval(() => {
    if (stream.aborted || stream.closed) return;
    void stream.write(": keepalive\n\n").catch(() => {});
  }, ms);
  // 双保险：流结束会 clearInterval；unref 避免空转计时器拖住进程退出。
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
```
2. 在 `streamTurn` 的 `return streamSSE(c, async (stream) => { … })` 回调里，最外层加 `startHeartbeat` + `try/finally`。把现有回调体整体包进去：
```ts
  return streamSSE(c, async (stream) => {
    const stopHeartbeat = startHeartbeat(stream, deps.config.heartbeatMs);
    try {
      // —— 原有回调体保持不变：先写 firstEvt，再 for-await 消费 gen，含 catch ——
      // （只是整体缩进进 try）
    } finally {
      stopHeartbeat();
    }
  });
```
> 实现者注意：仅"包裹"现有回调体，不改其内部逻辑（firstEvt 写出、`for await` 循环、`registry.recordResult/finishTurn`、abort/error 分支）。`SSEStreamingApi` 同时具备 `aborted`/`closed`/`write`，满足 `HeartbeatStream`，无需额外适配。

- [ ] **Step 4: 运行测试确认通过**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test heartbeat routes-sse`
Expected: PASS（heartbeat 三例 + routes-sse 既有用例不回归；因 `testConfig.heartbeatMs=0`，SSE 测试不产生心跳噪声）。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/routes/sessions.ts apps/runtime/test/heartbeat.test.ts
git commit -m "feat(p3): SSE :keepalive heartbeat (configurable, default 20s)"
```

---

### Task 6: abort 端到端测试（代码 P1 已就绪，补测）

**Files:**
- Modify: `apps/runtime/test/routes-sse.test.ts`

- [ ] **Step 1: 写失败/新测试**

在 `routes-sse.test.ts` 顶部 import 追加：
```ts
import type { QueryFn } from "../src/agent/runtime.js";
```

在 `describe("SSE routes", …)` 内追加：
```ts
  it("emits an aborted event when the active turn is stopped mid-flight", async () => {
    // 假 query：吐 init 后挂起，直到 abortController 触发（带 already-aborted 兜底，避免错过事件）。
    const queryFn: QueryFn = (args) => {
      const signal = args.options.abortController?.signal;
      return (async function* () {
        yield sampleMessages[0] as never; // init (sess-1)
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })();
    };
    const { app, registry } = makeApp({ queryFn });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    // 预读 init 已完成、会话已登记；中止当前轮。
    expect(registry.abort("sess-1")).toBe(true);
    const { events } = await collectSse(res);
    expect(events).toContain("aborted");
    expect(registry.get("sess-1")?.status).toBe("aborted");
  });
```

- [ ] **Step 2: 运行测试**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test routes-sse`
Expected: PASS（abort 代码 P1 已实现，应直接绿）。若超时/红：检查 `streamTurn` 的 catch 是否仍含 `if (abortController.signal.aborted) { … 'aborted' … }` 分支（不应被 Task 5 的 try/finally 包裹破坏）。

- [ ] **Step 3: 提交**

```bash
git add apps/runtime/test/routes-sse.test.ts
git commit -m "test(p3): end-to-end abort emits aborted event"
```

---

### Task 7: 容器硬化（compose 标准集 + Dockerfile 重定向/移除 curl-wget）

**Files:**
- Modify: `docker-compose.yml`（runtime 服务）
- Modify: `apps/runtime/Dockerfile`

- [ ] **Step 1: Dockerfile —— 缓存/配置重定向 + 末层移除 curl/wget**

在 `apps/runtime/Dockerfile` 的运行时 `ENV` 块（现有 `ENV DISABLE_AUTOUPDATER=1 … PATH=…`）里追加重定向变量（让 read-only rootfs 下所有写入落到 `/tmp` tmpfs 或卷）：
```dockerfile
    NPM_CONFIG_CACHE=/tmp/.npm \
    UV_CACHE_DIR=/tmp/.uv \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_DATA_HOME=/tmp/.local/share \
    GH_CONFIG_DIR=/tmp/.config/gh \
    GIT_CONFIG_GLOBAL=/tmp/.gitconfig \
    PNPM_HOME=/tmp/.pnpm \
```
> 关键：`GIT_CONFIG_GLOBAL=/tmp/.gitconfig` 让 entrypoint 的 `gh auth setup-git`（写全局 git config）在 read-only rootfs 下也能成功。`/claude-config`、`/workspace` 是卷（可写），不受影响。

在文件**最末尾**（`ENTRYPOINT` 之前）加一层 root RUN 移除仅构建期用到的 curl/wget（保留 `ca-certificates`/`gnupg`，git/gh/npm 的 TLS 需要）：
```dockerfile
# ---- 纵深防御：移除仅构建期用到的 curl/wget（运行时由白名单+disallowedTools 已禁，这里连二进制都不留）----
USER root
RUN apt-get purge -y curl wget && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
USER app
```
> 注意 `ENTRYPOINT` 必须仍是文件最后一行；上面的 USER 切换块放在它前面。`uv` 是独立二进制，不依赖运行时 curl。

- [ ] **Step 2: docker-compose.yml —— runtime 服务加标准硬化集**

在 `docker-compose.yml` 的 `runtime:` 服务下（与 `ports:`/`volumes:` 同级）追加：
```yaml
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 512
    mem_limit: 2g
    cpus: 2.0
    tmpfs:
      - /tmp:rw,nosuid,nodev,size=512m
```
> egress 选了"tool 层为主"，故**不**加 `cap_add: NET_ADMIN`（保持 `cap_drop: ALL`）。若日后启用 `egress-allowlist.sh`（Task 8），再按其文档加回 `cap_add: [NET_ADMIN]`。

- [ ] **Step 3: 构建并验证镜像可用**

Run（构建）:
```bash
docker compose build runtime
```
Expected: 构建成功；末层 purge 不报错。

Run（确认 curl/wget 已移除、claude 仍在）:
```bash
docker compose run --rm --no-deps --entrypoint sh runtime -c "command -v curl || echo NO_CURL; command -v wget || echo NO_WGET; claude --version; git --version; uv --version"
```
Expected: 打印 `NO_CURL`、`NO_WGET`，并打印 claude / git / uv 版本号。

> 完整的 read-only + 真实对话验证放在 Task 9（需 .env + 全栈）。本步只验证镜像本身没被硬化改动弄坏。

- [ ] **Step 4: 提交**

```bash
git add docker-compose.yml apps/runtime/Dockerfile
git commit -m "feat(p3): container hardening (read-only rootfs, cap_drop, limits, drop curl/wget)"
```

---

### Task 8: 可选 egress 白名单脚本 + 安全文档 + .env.example

**Files:**
- Create: `apps/runtime/container/egress-allowlist.sh`
- Create: `docs/superpowers/SECURITY-p3.md`
- Modify: `.env.example`

- [ ] **Step 1: 写 opt-in egress 脚本**

`apps/runtime/container/egress-allowlist.sh`：
```bash
#!/usr/bin/env bash
# 可选 egress 收紧（opt-in；默认 entrypoint 不调用）。
# 前提：容器有 NET_ADMIN（compose: cap_add:[NET_ADMIN]）且装了 iptables。
# 策略：默认 DROP 出站，仅放行 回环 + 已建立连接 + DNS + 白名单域名解析出的 IP(:80/:443)。
# 域名白名单经 EGRESS_ALLOW_DOMAINS（逗号分隔）传入；ANTHROPIC_BASE_URL 的 host 自动并入。
# 已知局限：*.githubusercontent.com / CDN 多 IP 且会轮换 → 启动时快照的 IP 可能过期（见 SECURITY-p3.md）。
set -euo pipefail

DOMAINS="${EGRESS_ALLOW_DOMAINS:-github.com,api.github.com,codeload.github.com,objects.githubusercontent.com,raw.githubusercontent.com,registry.npmjs.org,pypi.org,files.pythonhosted.org}"

if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  host="$(printf '%s' "$ANTHROPIC_BASE_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
  [ -n "$host" ] && DOMAINS="${DOMAINS},${host}"
fi

iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

IFS=',' read -ra arr <<< "$DOMAINS"
for d in "${arr[@]}"; do
  d="$(echo "$d" | xargs)"
  [ -z "$d" ] && continue
  for ip in $(getent ahostsv4 "$d" | awk '{print $1}' | sort -u); do
    iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$ip" --dport 80 -j ACCEPT
  done
done

echo "[egress] applied allowlist for: ${DOMAINS}"
```

- [ ] **Step 2: 写安全文档**

`docs/superpowers/SECURITY-p3.md`（要点齐全即可，无需冗长）：
```markdown
# P3 安全模型与运维说明

## 威胁模型
- 容器是真正隔离边界；CLI 以 `permissionMode:'bypassPermissions'` 无人值守运行。
- 防的是"过宽/意外的命令与出网"，**不**假设 agent 本身恶意。部署前提 = 可信网络。
- 密钥（`ANTHROPIC_API_KEY`/`GH_TOKEN`）仅经 `.env`/env，不进镜像/日志/OTel trace。

## 两层 Bash 强制
1. **PreToolUse hook**（`permissions/bash-allowlist.ts`）：解析 `tool_input.command`，按
   `&& || ; | & 换行` 与命令替换 `$()`/反引号边界拆分、剥 `timeout/nice/nohup/env/...` 包装器与
   `VAR=val` 前缀，逐子命令查 argv[0] basename 是否在白名单。任一不在即 `permissionDecision:'deny'`
   （绕过 canUseTool、连 bypassPermissions 都拦、覆盖子 agent）。白名单可经 `RUNTIME_BASH_ALLOWLIST` 覆盖。
2. **`disallowedTools` 兜底**：`Bash(curl:*)`/`Bash(wget:*)`/`Bash(sudo:*)`/`Bash(rm -rf:*)`（deny 永远赢）。

### 已知残留（可信网络下可接受）
- **exec-passthrough**：`find -exec <cmd>`、`npx <pkg>`、`xargs` 之类会执行白名单看不到的子命令。
  缓解：`xargs`/`sh`/`bash`/`eval` 不在默认白名单；curl/wget 二进制已从镜像移除 + disallowedTools 兜底。
- **brace group** `{ …; }`、复杂混淆：解析偏保守（宁可误拒），但非形式化沙箱。

## Egress（出网）
- 默认：tool 层为主——只放行 `git/gh/npm/uv` 等"有意出网口"，curl/wget 被禁且二进制已移除。
- 可选强化：`container/egress-allowlist.sh`（opt-in，需 `cap_add:[NET_ADMIN]`）默认 DROP 出站、按
  `EGRESS_ALLOW_DOMAINS` 域名快照 IP 放行。**局限**：CDN（githubusercontent 等）多 IP 且轮换，
  快照可能过期；启用前先在目标环境验证。

### 启用 egress 脚本
1. compose runtime 服务：`cap_add: [NET_ADMIN]`（并保留其余 cap_drop）。
2. 在 entrypoint `exec node` 之前插一行 `bash /app/apps/runtime/container/egress-allowlist.sh || true`，
   或以独立 init 容器运行。
3. 设 `EGRESS_ALLOW_DOMAINS`（可选；默认含 GitHub/npm/pypi + 自动并入 ANTHROPIC_BASE_URL host）。

## 容器硬化（compose 标准集）
`read_only` rootfs + `tmpfs /tmp` + `cap_drop:[ALL]` + `security_opt:[no-new-privileges]` +
`pids_limit` + `mem/cpu` 限额；非 root（uid 10001）。缓存/配置经 ENV 重定向到 `/tmp`
（`NPM_CONFIG_CACHE`/`UV_CACHE_DIR`/`XDG_*`/`GH_CONFIG_DIR`/`GIT_CONFIG_GLOBAL`/`PNPM_HOME`）。

## 韧性
- SSE `:keepalive` 心跳（`RUNTIME_SSE_HEARTBEAT_MS`，默认 20000，0=禁用）防反代 idle 断连；事件带 `id:`。
- 中止：`POST /sessions/:id/stop` → AbortController.abort() → 本轮发 `aborted` 事件。
- 断线重连：无状态每轮模型不做 mid-turn 续追；客户端重连后用 `GET /sessions/:id/transcript`
  取已完成内容，或开新一轮（resume 续上下文）。
```

- [ ] **Step 3: 更新 .env.example**

在 `.env.example` 末尾追加：
```bash
# —— P3 安全 ——
# Bash 命令白名单（逗号/空格分隔；留空=内置默认）。仅匹配 argv[0] 的 basename。
# RUNTIME_BASH_ALLOWLIST=git gh node npm npx pnpm python3 uv uvx ls cat rg
# SSE 心跳间隔（毫秒；0=禁用）。默认 20000，防反代 idle 断连。
# RUNTIME_SSE_HEARTBEAT_MS=20000
# 可选 egress 域名白名单（仅启用 container/egress-allowlist.sh 时生效）。
# EGRESS_ALLOW_DOMAINS=github.com,api.github.com,registry.npmjs.org,pypi.org
```

- [ ] **Step 4: 校验**

Run（脚本语法检查；bash 自带，无需 shellcheck）:
```bash
bash -n apps/runtime/container/egress-allowlist.sh && echo "egress script syntax OK"
```
Expected: `egress script syntax OK`。文档/.env.example 为静态内容，目视确认齐全即可。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/container/egress-allowlist.sh docs/superpowers/SECURITY-p3.md .env.example
git commit -m "docs(p3): opt-in egress allowlist script + security model + env sample"
```

---

### Task 9: 全栈实跑验收（docker compose + MiniMax）

**Files:** 无（验收步骤；产出记录到提交说明/记忆）。

> 前置：仓库根有 `.env`（含 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`、`RUNTIME_DEFAULT_MODEL=MiniMax-M3`；可选 `GH_TOKEN`）。本机 HTTP 代理在 127.0.0.1:1235，curl 本地服务用 `--noproxy '*'`。

- [ ] **Step 1: 质量门槛（全量）**

Run:
```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime test
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 --filter @app/runtime typecheck
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.1 check
```
Expected: 测试全绿（新增 bash-allowlist/heartbeat + 既有）；typecheck 0；biome exit 0。

- [ ] **Step 2: 起硬化后的全栈**

Run:
```bash
docker compose up -d --build
for i in $(seq 1 30); do c=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz); [ "$c" = "200" ] && { echo "healthz=200 after ${i}s"; break; }; sleep 1; done
docker inspect coding-agent-runtime-runtime-1 --format 'ReadOnly={{.HostConfig.ReadonlyRootfs}} CapDrop={{.HostConfig.CapDrop}} Pids={{.HostConfig.PidsLimit}}'
```
Expected: `healthz=200`；inspect 显示 `ReadOnly=true CapDrop=[ALL] Pids=512`。
> 若 healthz 起不来且日志显示某路径只读写失败：补对应 ENV 重定向（最可能漏的是某工具的 cache/config 目录）。这是 read-only rootfs 的预期调试点。

- [ ] **Step 3: 验收 ①——越权 bash 被拦并回有意义信息**

Run（让 agent 尝试运行 curl，应被 PreToolUse 拦下；用 SSE 流观察 tool_result/assistant）:
```bash
curl -s --noproxy '*' -N -X POST http://127.0.0.1:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"请用 Bash 工具执行：curl https://example.com 。如果被拒绝，把拒绝原因原样告诉我。"}' | tee /tmp/p3-deny.sse
```
Expected: 流里出现工具被拒（`tool_result` 带 is_error 或 assistant 文本复述"不在白名单/deny"原因）。验证 PreToolUse 白名单在真实 CLI 路径生效。
> 对照：换成允许的命令（如 `git status` / `ls /workspace`）应正常执行成功。

- [ ] **Step 4: 验收 ②——硬化容器仍能完成正常写文件轮**

Run:
```bash
curl -s --noproxy '*' -N -X POST http://127.0.0.1:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"在 /workspace 下创建 p3-ok.txt，内容写一行 hardened-ok"}' | tee /tmp/p3-ok.sse
docker exec coding-agent-runtime-runtime-1 cat /workspace/p3-ok.txt 2>/dev/null || cat .runtime/workspace/p3-ok.txt
```
Expected: SSE 出 `tool_use` Write + `result`；文件内容 = `hardened-ok`。证明 read-only rootfs + 缓存重定向没弄坏正常写入（写入落到 /workspace 卷）。

- [ ] **Step 5: 验收 ③——心跳 + 中止生效**

心跳（把间隔调小观测；compose 临时加 `RUNTIME_SSE_HEARTBEAT_MS=2000` 或在 .env 设）：
```bash
# 起一个会跑几秒的轮，过程中 SSE 原文应出现 ": keepalive" 注释行
curl -s --noproxy '*' -N -X POST http://127.0.0.1:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"读 /workspace 下所有文件并逐一总结，慢慢来"}' | grep -m1 "keepalive" && echo "HEARTBEAT OK"
```
中止：开一轮拿到 sessionId 后 `POST /sessions/:id/stop`，确认该轮 SSE 收到 `aborted` 事件（单测 Task 6 已覆盖逻辑；此处确认真实 CLI 路径下 abort 链路通）。
Expected: 观察到 `keepalive`；stop 后该轮收到 `aborted`。

- [ ] **Step 6: 拆栈 + 记录**

Run:
```bash
docker compose down
```
把验收结果（trace/命令产物）记入提交说明。更新记忆 `p2-implementation-status` 的"下一步"与新增 `p3-implementation-status`（由控制者在收尾阶段做，不在本 Task）。

---

## Self-Review（写计划者已核对）

**1. Spec coverage（spec §6 / §5 / §4.2 / 路线图 P3 行）**
- PreToolUse 解析式白名单（拆 `&& || ; |`、剥包装器）→ Task 1/2/4 ✓
- `disallowedTools` 兜底 → 既有，保留不动（Task 4 注明）✓
- egress 白名单 → Task 8（tool 层为主 + opt-in 脚本 + 文档，已确认务实降级）✓
- 容器硬化 → Task 7 ✓
- Last-Event-ID/心跳 → 心跳 Task 5；事件 id 既有；Last-Event-ID 续追经确认降级为 transcript 恢复（文档 Task 8）✓
- abort 接线 → 既有，Task 6 补测 ✓
- 验收"越权 bash 被拦并回有意义信息 / 断线可重连 / 中止生效" → Task 9 ✓

**2. Placeholder scan**：每个代码步骤含完整代码；命令含预期输出；无 TBD/“类似 Task N”。✓

**3. Type consistency**：
- `RuntimeConfig` 新增 `bashAllowlist:string[]`/`heartbeatMs:number` 在 config.ts/helpers.ts/config.test.ts 三处一致；`testConfig.heartbeatMs=0`。
- `createBashAllowlistHook` 返回 `HookCallback`；`Options.hooks.PreToolUse[0]={matcher:'Bash',hooks:[…]}` 与 SDK 类型吻合。
- `startHeartbeat(stream,ms)` 的 `HeartbeatStream` 由 `SSEStreamingApi`（含 aborted/closed/write）满足。
- deny 输出形状 `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason}}` 与 sdk.d.ts 一致。

**4. 风险点**：read-only rootfs 是最可能踩坑处（工具写 HOME/cache）；已用 ENV 重定向（含 `GIT_CONFIG_GLOBAL` 给 entrypoint 的 gh auth）覆盖，Task 9 Step 2 给了排查指引（缺哪个补哪个）。

---

## Execution Handoff

计划保存于 `docs/superpowers/plans/2026-06-05-coding-agent-runtime-p3.md`。沿用 P1/P2 的 **Subagent-Driven** 执行（每 Task 一个 implementer + 规范评审 + 质量评审，控制者审阅后推进），收尾做终审 + finishing-a-development-branch（`--no-ff` 合 main，保留特性分支）。

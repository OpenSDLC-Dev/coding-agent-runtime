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

# P3 Security Model & Operations

## Threat model
- The container is the real isolation boundary; the CLI runs unattended with `permissionMode:'bypassPermissions'`.
- The goal is to prevent **overly-broad / accidental commands and egress**, not to assume the agent itself is malicious. Deployment assumption = trusted network.
- Secrets (`ANTHROPIC_API_KEY` / `GH_TOKEN`) flow only through `.env`/env — never into the image, logs, or OTel traces.

## Two-layer Bash enforcement
1. **PreToolUse hook** (`permissions/bash-allowlist.ts`): parses `tool_input.command`, splitting on `&& || ; | &` and newlines plus command-substitution `$()` / backtick boundaries, stripping `timeout/nice/nohup/env/...` wrappers and `VAR=val` prefixes, then checking each sub-command's `argv[0]` basename against the allowlist. Any miss → `permissionDecision:'deny'` (bypasses canUseTool, blocks even under bypassPermissions, applies to sub-agents). The allowlist can be overridden via `RUNTIME_BASH_ALLOWLIST`.
2. **`disallowedTools` backstop**: `Bash(curl:*)` / `Bash(wget:*)` / `Bash(sudo:*)` / `Bash(rm -rf:*)` (deny always wins).

### Known residuals (acceptable on a trusted network)
- **exec-passthrough**: `find -exec <cmd>`, `npx <pkg>`, `xargs` and the like run sub-commands the allowlist cannot see. Mitigations: `xargs`/`sh`/`bash`/`eval` are not in the default allowlist; the curl/wget binaries are removed from the image, plus the disallowedTools backstop.
- **brace group** `{ …; }` and complex obfuscation: the parser errs conservative (prefers false-deny), but it is not a formal sandbox.

## Egress
- Default: tool-layer-primary — only "intentional egress" commands such as `git/gh/npm/uv` are allowed; curl/wget are blocked and their binaries removed.
- Optional hardening: `container/egress-allowlist.sh` (opt-in, requires `cap_add:[NET_ADMIN]`) defaults OUTPUT to DROP and allows snapshotted IPs for `EGRESS_ALLOW_DOMAINS`. **Limitation**: CDNs (githubusercontent, etc.) use many rotating IPs, so the snapshot can go stale; validate in your target environment before enabling.

### Enabling the egress script
1. compose runtime service: add `cap_add: [NET_ADMIN]` (keep the rest of `cap_drop`).
2. Insert `bash /app/apps/runtime/container/egress-allowlist.sh || true` before `exec node` in the entrypoint, or run it as a separate init container.
3. Set `EGRESS_ALLOW_DOMAINS` (optional; defaults include GitHub/npm/pypi + the `ANTHROPIC_BASE_URL` host automatically).

## Container hardening (compose standard set)
`read_only` rootfs + `tmpfs /tmp` + `cap_drop:[ALL]` + `security_opt:[no-new-privileges]` + `pids_limit` + `mem/cpu` limits; non-root (uid 10001). Caches/config are redirected to `/tmp` via ENV (`NPM_CONFIG_CACHE` / `UV_CACHE_DIR` / `XDG_*` / `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` / `PNPM_HOME`).

## Resilience
- SSE `:keepalive` heartbeat (`RUNTIME_SSE_HEARTBEAT_MS`, default 20000, 0 = disabled) to survive idle proxy disconnects; events carry `id:`.
- Abort: `POST /sessions/:id/stop` → `AbortController.abort()` → the turn emits an `aborted` event.
- Reconnect: the stateless per-turn model does no mid-turn resumption; after reconnecting, the client fetches completed content via `GET /sessions/:id/transcript`, or starts a new turn (resume preserves context).

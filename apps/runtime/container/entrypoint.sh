#!/usr/bin/env bash
# Runtime 容器入口：幂等写 CLAUDE.md + 配置 git/gh 认证 + 起服务。
set -euo pipefail

# 1) 把镜像内置的固定 guidelines 幂等写到 user-level CLAUDE.md（settingSources:['user'] 从这里读）。
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/claude-config}"
SRC_GUIDELINES="/app/apps/runtime/container/agent-CLAUDE.md"
DEST_GUIDELINES="${CLAUDE_CONFIG_DIR}/CLAUDE.md"

mkdir -p "${CLAUDE_CONFIG_DIR}"
if [ -f "${SRC_GUIDELINES}" ]; then
  if ! cmp -s "${SRC_GUIDELINES}" "${DEST_GUIDELINES}" 2>/dev/null; then
    cp -f "${SRC_GUIDELINES}" "${DEST_GUIDELINES}"
    echo "[entrypoint] wrote ${DEST_GUIDELINES}"
  fi
else
  echo "[entrypoint] WARNING: ${SRC_GUIDELINES} not found, skipping CLAUDE.md init" >&2
fi

# 2) 若提供 GH_TOKEN，让 git push/clone 也走 gh 凭据。
if [ -n "${GH_TOKEN:-}" ]; then
  echo "[entrypoint] configuring git to use gh credentials"
  gh auth setup-git
fi

# 3) exec node 成为 PID 1，正确转发 SIGTERM/SIGINT 做优雅停止。
exec node /app/apps/runtime/dist/index.js

#!/usr/bin/env bash
# Runtime container entrypoint: idempotently write CLAUDE.md + configure git/gh auth + start the service.
set -euo pipefail

# 1) Idempotently write the image's built-in fixed guidelines to the user-level CLAUDE.md (settingSources:['user'] reads from here).
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

# 2) If GH_TOKEN is provided, make git push/clone use gh credentials too.
if [ -n "${GH_TOKEN:-}" ]; then
  echo "[entrypoint] configuring git to use gh credentials"
  gh auth setup-git
fi

# 3) exec node to become PID 1, correctly forwarding SIGTERM/SIGINT for graceful shutdown.
exec node /app/apps/runtime/dist/index.js

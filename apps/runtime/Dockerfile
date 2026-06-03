# syntax=docker/dockerfile:1
# 基础镜像：Node 22 LTS on Debian 12 (bookworm)。用 slim 非 alpine —— SDK 自带 CLI 依赖 glibc/libstdc++。
FROM node:22-bookworm-slim

# ---- 系统层：编码工具 + gh（GitHub 官方 keyring apt 源）----
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        git \
        ripgrep \
        curl \
        ca-certificates \
        wget \
        gnupg \
        libstdc++6; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    out=$(mktemp); \
    wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
    cat "$out" | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    mkdir -p -m 755 /etc/apt/sources.list.d; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*

# ---- uv（astral 官方脚本）+ Python 3.12（装到系统 PATH，非 root 用户也能用）----
# uv 装到 /usr/local/bin（系统 PATH）。Python 3.12 必须显式指定共享目录：
#   UV_PYTHON_INSTALL_DIR=/opt/uv-python  解释器装到共享目录（默认是 root 家目录，app 用户读不到）
#   UV_PYTHON_BIN_DIR=/usr/local/bin      --default 生成的 python/python3/python3.12 软链放到系统 PATH
# 否则 app 用户 PATH 上没有 python3，且 uv 也找不到该解释器。
RUN set -eux; \
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_UNMANAGED_INSTALL=/usr/local/bin sh; \
    env UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON_BIN_DIR=/usr/local/bin uv python install 3.12 --default; \
    chmod -R a+rX /opt/uv-python

# ---- corepack 启用 pnpm（关下载交互提示，避免 build hang）----
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# ---- 固定 UID/GID 非 root 用户（与 bind mount chown 对齐）----
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash app

# ---- 应用目录 + 可挂载目录 ----
WORKDIR /app
RUN mkdir -p /workspace /claude-config \
    && chown -R app:app /app /workspace /claude-config

# ---- 先 COPY manifest 利用层缓存 ----
COPY --chown=app:app pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY --chown=app:app apps/runtime/package.json ./apps/runtime/package.json

USER app
RUN pnpm install --frozen-lockfile --filter @app/runtime...

# ---- COPY 剩余源码并编译 ----
COPY --chown=app:app . .
RUN pnpm --filter @app/runtime build

# entrypoint 需要可执行位（COPY 不保证保留）
USER root
RUN chmod +x /app/apps/runtime/container/entrypoint.sh
USER app

# ---- 运行时 ENV ----
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/claude-config \
    HOME=/home/app \
    PORT=8080 \
    RUNTIME_HOSTNAME=0.0.0.0 \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    PATH=/home/app/.local/share/pnpm:/home/app/.local/bin:/usr/local/bin:$PATH

EXPOSE 8080

ENTRYPOINT ["/app/apps/runtime/container/entrypoint.sh"]

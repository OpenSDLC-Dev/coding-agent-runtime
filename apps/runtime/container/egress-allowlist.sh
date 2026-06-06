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

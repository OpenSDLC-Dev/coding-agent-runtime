#!/usr/bin/env bash
# Optional egress hardening (opt-in; not invoked by the default entrypoint).
# Prerequisite: the container has NET_ADMIN (compose: cap_add:[NET_ADMIN]) and iptables installed.
# Policy: DROP outbound by default, only allow loopback + established connections + DNS + the IPs (:80/:443) resolved from allowlisted domains.
# The domain allowlist is passed via EGRESS_ALLOW_DOMAINS (comma-separated); the host of ANTHROPIC_BASE_URL is merged in automatically.
# Known limitation: *.githubusercontent.com / CDNs have many IPs that rotate -> the IPs snapshotted at startup may become stale (see SECURITY-p3.md).
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

#!/usr/bin/env bash
# File: ops/scripts/firewall-rules.sh
# Installed as /usr/local/sbin/plb-firewall-rules and re-applied at every boot BEFORE docker.service (plumbline-firewall.service)
# and after every docker (re)start (docker.service drop-in). Idempotent. `--check` only verifies and exits non-zero if a rule is gone
# (the broker and runner units run it as ExecStartPre, so they refuse to start without the firewall: AG4-OPS-2).
set -euo pipefail
BRIDGE=br-plb
SUBNET=172.28.0.0/24
GATE_IP=172.28.0.2
GATE_PORT=8080
BROKER_PORT=7443
CHAIN=PLB-SBX
MODE="${1:-apply}"

# INPUT: top first. The bridge may not talk to the host at all; the broker sandbox listener answers docker0 only.
INPUT_RULES=(
  "-i $BRIDGE -j DROP"
  "-i docker0 -p tcp --dport $BROKER_PORT -j ACCEPT"
  "-p tcp --dport $BROKER_PORT -j DROP"
)
# PLB-SBX (jumped to from DOCKER-USER): ICC is closed on the bridge (peers cannot reach each other or the gateway); the ONLY
# bridge-internal flow is sandbox -> relay:8080 (+ its replies); anything leaving the subnet is dropped and counted.
CHAIN_RULES=(
  "-i $BRIDGE -o $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  "-i $BRIDGE -o $BRIDGE -d $GATE_IP -p tcp --dport $GATE_PORT -j ACCEPT"
  "-i $BRIDGE -o $BRIDGE -j DROP"
  "-s $SUBNET ! -d $SUBNET -m comment --comment plb-egress -j DROP"
)

check() {
  local ok=0 r
  for r in "${INPUT_RULES[@]}"; do iptables -C INPUT $r 2>/dev/null || { echo "MISSING INPUT $r" >&2; ok=1; }; done
  iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || { echo "MISSING DOCKER-USER jump to $CHAIN" >&2; ok=1; }
  for r in "${CHAIN_RULES[@]}"; do iptables -C "$CHAIN" $r 2>/dev/null || { echo "MISSING $CHAIN $r" >&2; ok=1; }; done
  return $ok
}

apply() {
  local i r
  # DOCKER-USER may not exist yet when we run before docker.service; docker keeps an existing chain and appends its RETURN.
  iptables -N DOCKER-USER 2>/dev/null || true
  iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
  for r in "${CHAIN_RULES[@]}"; do iptables -A "$CHAIN" $r; done
  iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$CHAIN"
  for ((i = ${#INPUT_RULES[@]} - 1; i >= 0; i--)); do
    r="${INPUT_RULES[$i]}"
    iptables -C INPUT $r 2>/dev/null || iptables -I INPUT 1 $r
  done
}

# Teardown (used by local test runs and by teardown drills; the bootstrap never calls it).
remove() {
  local r i
  for ((i = 0; i < ${#INPUT_RULES[@]}; i++)); do r="${INPUT_RULES[$i]}"; while iptables -C INPUT $r 2>/dev/null; do iptables -D INPUT $r; done; done
  while iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null; do iptables -D DOCKER-USER -j "$CHAIN"; done
  iptables -F "$CHAIN" 2>/dev/null && iptables -X "$CHAIN" 2>/dev/null || true
}

case "$MODE" in
  apply) apply; check; echo "firewall rules in place" ;;
  --check|check) check && echo "firewall rules present" ;;
  remove) remove; echo "firewall rules removed" ;;
  *) echo "usage: $0 [apply|--check|remove]" >&2; exit 2 ;;
esac

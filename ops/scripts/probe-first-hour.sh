#!/usr/bin/env bash
# File: ops/scripts/probe-first-hour.sh
set -uo pipefail
MODE="${1:?mode: vm|owner}"
OUT="${PLUMBLINE_EVIDENCE:-/opt/plumbline/app/evidence}/probe-first-hour.txt"
mkdir -p "$(dirname "$OUT")"
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$OUT"; }

u4_egress() {
  say "U-4 egress shape: sandbox -> relay must work, sandbox -> 1.1.1.1 and -> host bridge gateway must fail"
  docker run --rm --network plb-sbx-net --read-only --cap-drop ALL --user 65534:65534 plumbline-sandbox:1 python -c "
import socket, urllib.request
def tcp(host, port):
    try:
        socket.create_connection((host, port), timeout=3).close(); return 'CONNECTED'
    except OSError as e:
        return 'FAILED ' + type(e).__name__
print('relay    :', tcp('plb-gate', 8080))
print('external :', tcp('1.1.1.1', 80))
print('gateway22:', tcp('172.28.0.1', 22))
print('gateway80:', tcp('172.28.0.1', 80))
print('docker0  :', tcp('172.17.0.1', 7443))" 2>&1 | tee -a "$OUT"
  say "U-4 expected: relay CONNECTED, all others FAILED. Anything else means the fallback (--network none + unix socket) is required."
}

u1_gvisor() {
  say "U-1/U-2 gVisor: one 30-minute attempt (R2). Claim only if the last line prints GVISOR OK."
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  apt-get update -y && apt-get install -y runsc && /usr/local/bin/runsc install && systemctl reload docker
  docker run --rm --runtime=runsc python:3.12-slim python -c "print('GVISOR OK')" 2>&1 | tee -a "$OUT" || say "U-1 FAILED: stay on hardened Docker; README: gVisor attempted, not claimed"
}

u3_kvm() { [ -e /dev/kvm ] && say "U-3 /dev/kvm present" || say "U-3 /dev/kvm absent (microVM dropped by R2 anyway)"; }

u9_caddy() {
  say "U-9 Caddy certificate: expect HTTP/2 200 over TLS on the sslip.io host"
  curl -sS -o /dev/null -w 'U-9 https status %{http_code} verify %{ssl_verify_result}\n' "https://$(curl -fsS https://api.ipify.org | tr . -).sslip.io/healthz" | tee -a "$OUT" \
    || say "U-9 FAILED: rerun bootstrap-vm.sh with --http-fallback"
}

case "$MODE" in
  vm) u4_egress; u3_kvm; u9_caddy; u1_gvisor ;;
  owner)
    say "U-5  run: npx tsx -e \"import('./packages/vultr-adapter/src/s3.ts')\"  then put, put, delete, listVersions, restore against ewr1 (script lives in the build agent's scratch); fallback: pinned boto3 helper"
    say "U-6  create a throwaway service user with subscriptions_view + billing and GET /v2/billing/pending-charges (costs nothing); fallback: lists only"
    say "U-10 read date_expire in the issueKey response (bootstrap-range prints a WARNING when it is missing)"
    say "U-11 try DELETE /users/{id}/ip-whitelist/{ip}/32 and the subnet-id forms on a throwaway user; fallback: recreate the user"
    say "U-12 create free firewall groups until 429/422, then delete them; cap concurrent sessions at 80% of the measured number"
    say "U-13 60-call burst to qwen3.8-27b through the broker proxy; record 429s and p95"
    say "U-14 20 trials x the 5 canned attacks through /api/attack; record how many attempt the call (fallback: glm-5.3 as executor)"
    say "U-15 after the first full hour compare the ledger sum to GET /v2/billing/pending-charges; record the ratio"
    ;;
  *) echo "unknown mode" >&2; exit 2 ;;
esac

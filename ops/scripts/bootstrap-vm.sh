#!/usr/bin/env bash
# File: ops/scripts/bootstrap-vm.sh
# Usage: bootstrap-vm.sh broker|verifier [--http-fallback] [--verify-net]
#   --http-fallback  serve Caddy over plain http (U-9 fallback)
#   --verify-net     broker only: run the sandbox network self-check (U-4 shape + H-4 DNS) and exit; also runs at the end of a full bootstrap
# Environment: PLB_DOCKER_CE=1 installs docker-ce from Docker's apt repository when the distro docker.io is older than 26.0.
set -euo pipefail
ROLE="${1:?role: broker|verifier}"
shift || true
HTTP_FALLBACK=0; VERIFY_ONLY=0
for a in "$@"; do
  case "$a" in
    --http-fallback) HTTP_FALLBACK=1 ;;
    --verify-net) VERIFY_ONLY=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
APP=/opt/plumbline/app
SBX_NET=plb-sbx-net; SBX_BRIDGE=br-plb; SBX_SUBNET=172.28.0.0/24; SBX_GATEWAY=172.28.0.1
GATE=plb-gate; GATE_IP=172.28.0.2; GATE_PORT=8080
SBX_IMAGE=plumbline-sandbox:1
MIN_DOCKER_MAJOR=26
export DEBIAN_FRONTEND=noninteractive

fail() { echo "BOOTSTRAP_REFUSED: $*" >&2; exit 1; }

docker_server_version() { docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0; }

install_docker_ce() {
  apt-get remove -y docker.io >/dev/null 2>&1 || true
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io
}

# CO-2 H-4: below 26.0 the embedded DNS of an --internal network still forwards to external resolvers (DNS exfiltration). Hard stop.
ensure_docker() {
  command -v docker >/dev/null || apt-get install -y docker.io
  systemctl enable --now docker
  local v; v="$(docker_server_version)"
  if [ "${v%%.*}" -lt "$MIN_DOCKER_MAJOR" ] && [ "${PLB_DOCKER_CE:-0}" = 1 ]; then
    install_docker_ce; systemctl enable --now docker; v="$(docker_server_version)"
  fi
  [ "${v%%.*}" -ge "$MIN_DOCKER_MAJOR" ] || fail "Docker $v is older than $MIN_DOCKER_MAJOR.0 (DNS exfiltration from internal networks). Re-run with PLB_DOCKER_CE=1 to install docker-ce."
  echo "docker $v ok (>= $MIN_DOCKER_MAJOR.0)"
}

# AG4-OPS-2: the rules survive reboot (plumbline-firewall.service runs before docker.service) and are re-applied after every docker restart.
install_firewall() {
  install -m 0755 "$APP/ops/scripts/firewall-rules.sh" /usr/local/sbin/plb-firewall-rules
  install -m 0644 "$APP/ops/systemd/plumbline-firewall.service" /etc/systemd/system/
  install -d /etc/systemd/system/docker.service.d
  install -m 0644 "$APP/ops/systemd/docker-firewall.conf" /etc/systemd/system/docker.service.d/plumbline-firewall.conf
  modprobe br_netfilter
  echo br_netfilter > /etc/modules-load.d/plumbline.conf
  printf 'net.bridge.bridge-nf-call-iptables=1\n' > /etc/sysctl.d/99-plumbline.conf
  sysctl -q -w net.bridge.bridge-nf-call-iptables=1
  systemctl daemon-reload
  systemctl enable plumbline-firewall.service
  systemctl restart plumbline-firewall.service
  /usr/local/sbin/plb-firewall-rules --check
}

# AG4-SBX-4: --internal (no route off the subnet), ICC off (sandboxes cannot reach each other), fixed bridge name for the host rules.
ensure_sandbox_network() {
  if docker network inspect "$SBX_NET" >/dev/null 2>&1; then
    local got want="true false $SBX_BRIDGE $SBX_SUBNET"
    got="$(docker network inspect -f '{{.Internal}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{index .Options "com.docker.network.bridge.name"}} {{(index .IPAM.Config 0).Subnet}}' "$SBX_NET")"
    [ "$got" = "$want" ] || fail "$SBX_NET exists with settings '$got', expected '$want'. Remove it (docker network rm) and re-run."
  else
    docker network create --internal --subnet "$SBX_SUBNET" --gateway "$SBX_GATEWAY" \
      -o "com.docker.network.bridge.name=$SBX_BRIDGE" -o com.docker.network.bridge.enable_icc=false "$SBX_NET"
  fi
}

build_sandbox_image() {
  local base
  base=$(docker pull -q python:3.12-slim >/dev/null && docker image inspect --format '{{index .RepoDigests 0}}' python:3.12-slim)
  echo "$base" > "$APP/ops/sandbox-base.digest"
  docker build --build-arg "BASE_IMAGE=$base" -t "$SBX_IMAGE" "$APP/packages/sandbox/image"
}

# The relay: dual-homed (sandbox net with a fixed IP + docker0), no capabilities, read-only, non-root, tiny limits.
# Created, wired to docker0, then started, so it never runs half-connected.
ensure_gate() {
  local img
  img=$(docker pull -q node:24-slim >/dev/null && docker image inspect --format '{{index .RepoDigests 0}}' node:24-slim)
  echo "$img" > "$APP/ops/gate-base.digest"
  docker rm -f "$GATE" >/dev/null 2>&1 || true
  docker create --name "$GATE" --restart unless-stopped --network "$SBX_NET" --ip "$GATE_IP" \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=8m --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 \
    --pids-limit 32 --memory 64m --memory-swap 64m --cpus 0.5 \
    -v "$APP/packages/sandbox/gate/relay.mjs:/relay.mjs:ro" "$img" node /relay.mjs >/dev/null
  docker network connect bridge "$GATE"
  docker start "$GATE" >/dev/null
}

sandbox_python() { # run python from the sandbox image on the sandbox network, hardened like a task container
  docker run --rm --network "$SBX_NET" --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 --pids-limit 32 --memory 64m \
    --entrypoint python "$@"
}

# The U-4 shape plus CO-2 H-4. Prints one result line per check; returns non-zero on any mismatch.
verify_sandbox_net() (
  local peer ip out bad=0 want
  peer=plb-probe-peer-$$
  trap 'docker rm -f "$peer" >/dev/null 2>&1 || true' EXIT
  docker run -d --name "$peer" --network "$SBX_NET" --read-only --cap-drop ALL --user 65534:65534 --entrypoint python "$SBX_IMAGE" \
    -c "import socket,time; s=socket.socket(); s.bind(('0.0.0.0',9000)); s.listen(5); time.sleep(60)" >/dev/null
  ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$SBX_NET\").IPAddress}}" "$peer")
  sleep 1
  out=$(sandbox_python "$SBX_IMAGE" -c "
import socket
def tcp(h, p):
    try:
        socket.create_connection((h, p), timeout=3).close(); return 'CONNECTED'
    except OSError:
        return 'FAILED'
def dns(name):
    try:
        socket.getaddrinfo(name, 80); return 'RESOLVED'
    except OSError:
        return 'FAILED'
print('relay', tcp('$GATE_IP', $GATE_PORT))
print('external', tcp('1.1.1.1', 80))
print('gateway22', tcp('$SBX_GATEWAY', 22))
print('gateway80', tcp('$SBX_GATEWAY', 80))
print('docker0_7443', tcp('172.17.0.1', 7443))
print('peer', tcp('$ip', 9000))
print('dns_example_com', dns('example.com'))
print('dns_one_one_one_one', dns('one.one.one.one'))
")
  echo "$out"
  want=$'relay CONNECTED\nexternal FAILED\ngateway22 FAILED\ngateway80 FAILED\ndocker0_7443 FAILED\npeer FAILED\ndns_example_com FAILED\ndns_one_one_one_one FAILED'
  [ "$out" = "$want" ] || { echo "NET_CHECK_FAILED: expected relay CONNECTED and everything else FAILED (incl. getaddrinfo: CO-2 H-4). Anything else means the --network none + unix socket fallback (U-4)." >&2; bad=1; }
  exit $bad
)

install_sudoers() {
  install -m 0755 "$APP/ops/scripts/egress-counter.sh" /usr/local/sbin/plb-egress-counter
  install -m 0440 "$APP/ops/sudoers/plumbline-egress" /etc/sudoers.d/plumbline-egress.new
  visudo -cf /etc/sudoers.d/plumbline-egress.new >/dev/null || { rm -f /etc/sudoers.d/plumbline-egress.new; fail "sudoers file did not validate"; }
  mv /etc/sudoers.d/plumbline-egress.new /etc/sudoers.d/plumbline-egress
}

if [ "$VERIFY_ONLY" = 1 ]; then
  [ "$ROLE" = broker ] || fail "--verify-net is for the broker role"
  ensure_docker; verify_sandbox_net; exit $?
fi

apt-get update -y
apt-get install -y ca-certificates curl gnupg git sqlite3 iptables caddy
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
getent group plumbline-ipc >/dev/null || groupadd plumbline-ipc
getent group plumbline-vm2 >/dev/null || groupadd plumbline-vm2
for u in broker runner api verifier watchdog; do id "plumbline-$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "plumbline-$u"; done
mkdir -p /etc/plumbline /var/lib/plumbline /var/lib/plumbline-shared
chmod 700 /etc/plumbline
(cd "$APP" && npm ci)
NET_OK=0
if [ "$ROLE" = "broker" ]; then
  ensure_docker
  usermod -aG docker plumbline-runner
  for u in api runner broker; do usermod -aG plumbline-ipc "plumbline-$u"; done
  chown plumbline-broker:plumbline-ipc /var/lib/plumbline && chmod 750 /var/lib/plumbline
  printf 'd /run/plumbline 2770 plumbline-broker plumbline-ipc -\n' > /etc/tmpfiles.d/plumbline.conf && systemd-tmpfiles --create
  install_firewall
  ensure_sandbox_network
  build_sandbox_image
  ensure_gate
  install_sudoers
  /usr/local/sbin/plb-firewall-rules --check
  verify_sandbox_net || NET_OK=1
  SITE_ENV="PLUMBLINE_HOST=$(curl -fsS https://api.ipify.org | tr . -).sslip.io"
  CADDYFILE="$APP/ops/Caddyfile.broker"; UNITS="broker runner api"
else
  chown plumbline-verifier:plumbline-vm2 /var/lib/plumbline-shared && chmod 2770 /var/lib/plumbline-shared
  usermod -aG plumbline-vm2 plumbline-watchdog plumbline-verifier
  SITE_ENV="PLUMBLINE_VERIFIER_HOST_PUBLIC=$(curl -fsS https://api.ipify.org | tr . -).sslip.io"
  CADDYFILE="$APP/ops/Caddyfile.verifier"; UNITS="verifier watchdog"
fi
echo "$SITE_ENV" >> /etc/default/caddy
if [ "$HTTP_FALLBACK" = 1 ]; then sed 's#^{\$\([A-Z_]*\)} {#http://{$\1} {#' "$CADDYFILE" > /etc/caddy/Caddyfile; else cp "$CADDYFILE" /etc/caddy/Caddyfile; fi
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/default/caddy\n' > /etc/systemd/system/caddy.service.d/env.conf
for unit in $UNITS; do install -m 0644 "$APP/ops/systemd/plumbline-$unit.service" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable --now caddy
echo "units installed: $UNITS. Copy /etc/plumbline/*.env from the owner machine, then: systemctl enable --now $(for u in $UNITS; do printf 'plumbline-%s ' "$u"; done)"
[ "$NET_OK" = 0 ] || fail "sandbox network self-check failed (see NET_CHECK_FAILED above). Do not start services until U-4 is decided."

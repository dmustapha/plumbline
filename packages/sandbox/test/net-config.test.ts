import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GATE_IP, GATE_PORT, SANDBOX_BRIDGE, SANDBOX_GATEWAY, SANDBOX_NETWORK, SANDBOX_SUBNET, gateCreateArgs, networkCreateArgs } from '../src/index.ts';

const OPS = fileURLToPath(new URL('../../../ops/', import.meta.url));
const read = (rel: string): string => readFileSync(`${OPS}${rel}`, 'utf8');
const bootstrap = read('scripts/bootstrap-vm.sh');
const firewall = read('scripts/firewall-rules.sh');

describe('AG4-SBX-4 network, ICC, DOCKER-USER and gate flags are defined in the bootstrap', () => {
  it('the network is created --internal, with the subnet, gateway, bridge name and ICC disabled', () => {
    const args = networkCreateArgs();
    expect(args).toEqual(expect.arrayContaining(['--internal', '--subnet', SANDBOX_SUBNET, '--gateway', SANDBOX_GATEWAY, 'com.docker.network.bridge.enable_icc=false', `com.docker.network.bridge.name=${SANDBOX_BRIDGE}`]));
    expect(args.at(-1)).toBe(SANDBOX_NETWORK);
    expect(bootstrap).toMatch(/docker network create --internal --subnet "\$SBX_SUBNET" --gateway "\$SBX_GATEWAY"/);
    expect(bootstrap).toContain('-o com.docker.network.bridge.enable_icc=false');
    expect(bootstrap).toContain('-o "com.docker.network.bridge.name=$SBX_BRIDGE"');
    expect(bootstrap).toContain(`SBX_NET=${SANDBOX_NETWORK}; SBX_BRIDGE=${SANDBOX_BRIDGE}; SBX_SUBNET=${SANDBOX_SUBNET}; SBX_GATEWAY=${SANDBOX_GATEWAY}`);
  });
  it('an existing network with the wrong settings stops the bootstrap instead of being reused', () => {
    expect(bootstrap).toContain('want="true false $SBX_BRIDGE $SBX_SUBNET"');
    expect(bootstrap).toMatch(/\[ "\$got" = "\$want" \] \|\| fail/);
  });
  it('the gate container flags in the script equal the flags the Docker tests use', () => {
    const args = gateCreateArgs({ relayPath: '$APP/packages/sandbox/gate/relay.mjs', image: '$img' });
    for (const flag of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '32', '--memory', '64m', '--memory-swap', '--cpus', '0.5', '--ip', GATE_IP, '--restart', 'unless-stopped']) {
      expect(args, flag).toContain(flag);
    }
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--cap-add');
    const script = bootstrap.replace(/\\\n\s*/g, ' ');
    for (const frag of ['--read-only', '--tmpfs /tmp:rw,noexec,nosuid,size=8m', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 65534:65534', '--pids-limit 32', '--memory 64m', '--memory-swap 64m', '--cpus 0.5', '--ip "$GATE_IP"', '--restart unless-stopped', '-v "$APP/packages/sandbox/gate/relay.mjs:/relay.mjs:ro"']) {
      expect(script, frag).toContain(frag);
    }
    expect(bootstrap).toContain(`GATE_IP=${GATE_IP}; GATE_PORT=${GATE_PORT}`);
  });
  it('the relay is created, wired to docker0, and only then started', () => {
    const create = bootstrap.indexOf('docker create --name "$GATE"');
    const connect = bootstrap.indexOf('docker network connect bridge "$GATE"');
    const start = bootstrap.indexOf('docker start "$GATE"');
    expect(create).toBeGreaterThan(0);
    expect(connect).toBeGreaterThan(create);
    expect(start).toBeGreaterThan(connect);
  });
  it('the DOCKER-USER rules close ICC, allow only sandbox -> relay:8080, drop and count everything leaving the subnet', () => {
    expect(firewall).toContain(`BRIDGE=${SANDBOX_BRIDGE}`);
    expect(firewall).toContain(`SUBNET=${SANDBOX_SUBNET}`);
    expect(firewall).toContain(`GATE_IP=${GATE_IP}`);
    expect(firewall).toContain(`GATE_PORT=${GATE_PORT}`);
    expect(firewall).toContain('"-i $BRIDGE -o $BRIDGE -d $GATE_IP -p tcp --dport $GATE_PORT -j ACCEPT"');
    expect(firewall).toContain('"-i $BRIDGE -o $BRIDGE -j DROP"');
    expect(firewall).toContain('"-s $SUBNET ! -d $SUBNET -m comment --comment plb-egress -j DROP"');
    expect(firewall).toContain('iptables -I DOCKER-USER 1 -j "$CHAIN"');
    const accept = firewall.indexOf('-d $GATE_IP -p tcp --dport $GATE_PORT -j ACCEPT');
    const drop = firewall.indexOf('"-i $BRIDGE -o $BRIDGE -j DROP"');
    expect(accept).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(accept);
  });
  it('the host drops everything from the sandbox bridge and exposes the broker listener to docker0 only', () => {
    expect(firewall).toContain('"-i $BRIDGE -j DROP"');
    expect(firewall).toContain('"-i docker0 -p tcp --dport $BROKER_PORT -j ACCEPT"');
    expect(firewall).toContain('"-p tcp --dport $BROKER_PORT -j DROP"');
  });
  it('the egress counter reads the chain the firewall script writes, and the sudoers entry allows no arguments', () => {
    expect(read('scripts/egress-counter.sh')).toContain('iptables -L PLB-SBX');
    expect(firewall).toContain('CHAIN=PLB-SBX');
    expect(read('sudoers/plumbline-egress')).toMatch(/NOPASSWD: \/usr\/local\/sbin\/plb-egress-counter ""\s*$/m);
    expect(bootstrap).toContain('visudo -cf');
  });
});

describe('AG4-OPS-2 firewall rules persist across reboot and are applied before containers start', () => {
  const unit = read('systemd/plumbline-firewall.service');
  it('a oneshot unit runs before docker.service and docker.service requires it', () => {
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^RemainAfterExit=yes$/m);
    expect(unit).toMatch(/^DefaultDependencies=no$/m);
    expect(unit).toMatch(/^Before=.*\bdocker\.service\b/m);
    expect(unit).toMatch(/^Before=.*\bplumbline-broker\.service\b.*\bplumbline-runner\.service\b/m);
    expect(unit).toMatch(/^RequiredBy=docker\.service$/m);
    expect(unit).toContain('ExecStart=/usr/local/sbin/plb-firewall-rules apply');
  });
  it('docker restarts re-apply the rules (drop-in) and the bootstrap enables both', () => {
    expect(read('systemd/docker-firewall.conf')).toMatch(/^ExecStartPost=\/usr\/local\/sbin\/plb-firewall-rules apply$/m);
    expect(bootstrap).toContain('systemctl enable plumbline-firewall.service');
    expect(bootstrap).toContain('/etc/systemd/system/docker.service.d/plumbline-firewall.conf');
    expect(bootstrap).toContain('br_netfilter');
  });
  it('broker and runner refuse to start when a rule is missing (ExecStartPre check, run as root)', () => {
    for (const f of ['plumbline-broker.service', 'plumbline-runner.service']) {
      const text = read(`systemd/${f}`);
      expect(text, f).toContain('ExecStartPre=+/usr/local/sbin/plb-firewall-rules --check');
      expect(text, f).toMatch(/^Requires=.*plumbline-firewall\.service/m);
    }
  });
  it('the check probes the exact rule named in the finding', () => {
    expect(firewall).toContain('"-i $BRIDGE -j DROP"');
    expect(firewall).toMatch(/--check\|check\)/);
  });
});

describe('AG4-OPS-3 the runner unit is hardened and does not pretend to be isolated from docker', () => {
  const text = read('systemd/plumbline-runner.service');
  it('has the systemd sandboxing directives', () => {
    for (const d of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'CapabilityBoundingSet=', 'RestrictAddressFamilies=AF_UNIX', 'ProtectKernelTunables=true', 'RestrictSUIDSGID=true', 'UMask=0117']) {
      expect(text, d).toMatch(new RegExp(`^${d}$`, 'm'));
    }
  });
  it('its comment names the docker-group risk', () => {
    expect(text).toMatch(/docker group is root-equivalent/);
  });
});

describe('CO-2 H-4 the bootstrap enforces Docker >= 26.0 and a failing getaddrinfo', () => {
  it('asserts the docker major version and refuses below 26', () => {
    expect(bootstrap).toContain('MIN_DOCKER_MAJOR=26');
    expect(bootstrap).toMatch(/\[ "\$\{v%%\.\*\}" -ge "\$MIN_DOCKER_MAJOR" \] \|\| fail "Docker \$v is older than/);
  });
  it('the network self-check resolves external names from a sandbox container and demands failure', () => {
    expect(bootstrap).toContain("socket.getaddrinfo(name, 80)");
    expect(bootstrap).toContain("dns('example.com')");
    expect(bootstrap).toContain('dns_example_com FAILED');
    expect(bootstrap).toContain('relay CONNECTED');
    expect(bootstrap).toContain('peer FAILED');
    expect(bootstrap).toMatch(/--verify-net/);
  });
  it('a failed self-check fails the bootstrap after everything is installed', () => {
    expect(bootstrap).toMatch(/\[ "\$NET_OK" = 0 \] \|\| fail/);
  });
});

describe('script hygiene', () => {
  it('every shell script parses (bash -n)', () => {
    for (const f of ['bootstrap-vm.sh', 'firewall-rules.sh', 'egress-counter.sh']) execFileSync('bash', ['-n', `${OPS}scripts/${f}`]);
  });
  it('scripts are executable', () => {
    for (const f of ['bootstrap-vm.sh', 'firewall-rules.sh', 'egress-counter.sh']) expect(statSync(`${OPS}scripts/${f}`).mode & 0o111, f).not.toBe(0);
  });
  it('env templates hold names only: no secret-shaped value (paths excluded)', () => {
    for (const f of ['broker', 'runner', 'api']) {
      for (const line of read(`env/${f}.env.example`).split('\n').filter((l) => /^[A-Z_]+=/.test(l))) {
        const value = line.slice(line.indexOf('=') + 1);
        if (value.startsWith('/') || value.startsWith('http')) continue;
        expect(value, line).not.toMatch(/^[A-Za-z0-9+/]{20,}$/);
      }
    }
  });
});

describe('SEC REVIEW (opus) fixes on the VM hardening', () => {
  it('SEC-S2 IPv6 cannot be a side door: the bridge is dropped in ip6tables INPUT and FORWARD, applied and checked', () => {
    const fw = read('scripts/firewall-rules.sh');
    expect(fw).toMatch(/ip6tables -I INPUT 1 -i "\$BRIDGE" -j DROP/);
    expect(fw).toMatch(/ip6tables -I FORWARD 1 -i "\$BRIDGE" -j DROP/);
    expect(fw).toMatch(/ip6tables -C INPUT -i "\$BRIDGE" -j DROP 2>\/dev\/null \|\| \{ echo "MISSING/);
  });
  it('SEC-S6 the runner has its own 0700 runtime directory for the docker config; no Environment line carries an inline comment', () => {
    const unit = read('systemd/plumbline-runner.service');
    expect(unit).toMatch(/^RuntimeDirectory=plumbline-runner$/m);
    expect(unit).toMatch(/^RuntimeDirectoryMode=0700$/m);
    expect(unit).toMatch(/^Environment=DOCKER_CONFIG=\/run\/plumbline-runner$/m);
    for (const line of unit.split('\n').filter((l) => l.startsWith('Environment='))) expect(line).not.toContain('#');
  });
  it('SEC-S6 /run/plumbline is sticky (3770) so one service cannot unlink another service socket', () => {
    expect(read('scripts/bootstrap-vm.sh')).toMatch(/d \/run\/plumbline 3770 plumbline-broker plumbline-ipc/);
  });
  it('SEC-S1 sandbox containers never use a log driver that writes their stdout to the host disk', async () => {
    const { buildRunArgs } = await import('../src/index.ts');
    const args = buildRunArgs({ name: 'x', limits: { mem_mb: 128, cpus: 0.5, pids: 64, wall_s: 10 } } as never);
    expect(args.slice(args.indexOf('--log-driver'), args.indexOf('--log-driver') + 2)).toEqual(['--log-driver', 'none']);
  });
});

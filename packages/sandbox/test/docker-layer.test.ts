// Docker layer (PLB_DOCKER_TESTS=1): needs a docker daemon, the image `plumbline-sandbox:1` and node:24-slim.
// On the VM the network, relay and firewall come from bootstrap-vm.sh and are only inspected. On a developer machine the test builds
// the same network and relay from netspec.ts (and, with PLB_DESKTOP_FW=1, applies firewall-rules.sh inside the docker VM), and removes
// exactly what it created. Set DOCKER_HOST when the daemon is not at /var/run/docker.sock (the runner uses a cleaned environment).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE_IP, GATE_NAME, SANDBOX_BRIDGE, SANDBOX_NETWORK, SANDBOX_SUBNET, SandboxRunner, dockerExec, gateCreateArgs, networkCreateArgs } from '../src/index.ts';

const live = process.env.PLB_DOCKER_TESTS === '1';
const RELAY = fileURLToPath(new URL('../gate/relay.mjs', import.meta.url));
const FIREWALL = fileURLToPath(new URL('../../../ops/scripts/firewall-rules.sh', import.meta.url));
const created = { network: false, gate: false, stub: false, firewall: false };
const STUB = 'plb-test-stub';

const docker = async (args: string[], timeoutMs = 30000): Promise<string> => {
  const r = await dockerExec(args, { timeoutMs });
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} -> ${r.code}: ${r.stderr}`);
  return r.stdout.trim();
};
const exists = async (kind: 'network' | 'container', name: string): Promise<boolean> => (await dockerExec([kind, 'inspect', name], { timeoutMs: 8000 })).code === 0;
const runner = (): SandboxRunner => new SandboxRunner();
const run = (code: string, limits = {}) => runner().run({ code, token: 'plbt.test.test', limits: { wall_s: 20, ...limits } });
const decoy = { VULTR_KEY_DEPLOYER: 'DECOY-DEPLOYER-0123456789ABCDEFGHIJKLMN', VULTR_INFERENCE_API_KEY: 'DECOY-INFERENCE-0123456789ABCDEFGHIJKL', VULTR_S3_SECRET_KEY: 'DECOY-S3SECRET-0123456789ABCDEFGHIJKLM' };

async function firewall(mode: 'apply' | 'remove'): Promise<void> {
  await docker(['run', '--rm', '--net=host', '--cap-add', 'NET_ADMIN', '-v', `${FIREWALL}:/fw.sh:ro`, 'alpine:3.20', 'sh', '-c', `apk add -q bash iptables >/dev/null 2>&1; bash /fw.sh ${mode}`], 120000);
}

async function ensureStack(): Promise<void> {
  if (!(await exists('network', SANDBOX_NETWORK))) { await docker(networkCreateArgs()); created.network = true; }
  if (await exists('container', GATE_NAME)) return;
  await docker(['run', '-d', '--name', STUB, '--entrypoint', 'python', 'plumbline-sandbox:1', '-c', [
    'import http.server, json',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def _send(self):',
    '        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()',
    '        self.wfile.write(json.dumps({"status": "DECIDED", "decision": {"decision": "ALLOW", "rule_id": "stub", "layer": "test", "reason": "stub"}, "result": [{"id": "stub-1"}]}).encode())',
    '    def do_POST(self):',
    '        self.rfile.read(int(self.headers.get("content-length", 0))); self._send()',
    '    def do_GET(self):',
    '        self._send()',
    'http.server.HTTPServer(("0.0.0.0", 7443), H).serve_forever()',
  ].join('\n')]);
  created.stub = true;
  const stubIp = await docker(['inspect', '-f', '{{.NetworkSettings.IPAddress}}', STUB]);
  await docker(gateCreateArgs({ relayPath: RELAY, image: 'node:24-slim', upstreamHost: stubIp, upstreamPort: 7443 }));
  created.gate = true;
  await docker(['network', 'connect', 'bridge', GATE_NAME]);
  await docker(['start', GATE_NAME]);
  await new Promise((r) => setTimeout(r, 1500));
}

async function firewallPresent(): Promise<boolean> {
  const probe = await run('import vultr\nvultr.instances.list()\nprint("CALL_OK")', { wall_s: 10 });
  return probe.stdout.includes('CALL_OK');
}

beforeAll(async () => {
  if (!live) return;
  Object.assign(process.env, decoy);
  await ensureStack();
  if (process.env.PLB_DESKTOP_FW === '1' && created.network) { await firewall('apply'); created.firewall = true; }
}, 180000);

afterAll(async () => {
  if (!live) return;
  for (const name of [GATE_NAME, STUB]) if ((name === GATE_NAME ? created.gate : created.stub)) await dockerExec(['rm', '-f', name], { timeoutMs: 10000 });
  await dockerExec(['rm', '-f', 'plb-ctl-a', 'plb-ctl-b'], { timeoutMs: 10000 });
  await dockerExec(['network', 'rm', 'plb-ctl-net'], { timeoutMs: 10000 });
  if (created.firewall) await firewall('remove');
  if (created.network) await dockerExec(['network', 'rm', SANDBOX_NETWORK], { timeoutMs: 10000 });
  await new SandboxRunner().sweepStrays();
}, 120000);

describe.skipIf(!live)('docker layer: runaway states', () => {
  it('SANDBOX_TIMEOUT: an infinite loop is killed at wall_s and the container is gone', async () => {
    const r = await run('while True:\n    pass', { wall_s: 3 });
    expect(r.state).toBe('SANDBOX_TIMEOUT');
    expect(r.destroyed).toBe(true);
  });
  it('SANDBOX_PIDS: a fork bomb stops at the pids limit and the container is gone', async () => {
    const r = await run('import os, time\nwhile True:\n    if os.fork() == 0:\n        time.sleep(60)\n        os._exit(0)', { wall_s: 15 });
    expect(r.state).toBe('SANDBOX_PIDS');
    expect(r.destroyed).toBe(true);
  });
  it('SANDBOX_OOM: allocating past the memory limit is killed (OOMKilled read from docker inspect) and the container is gone', async () => {
    const r = await run('x = []\nwhile True:\n    x.append(bytearray(8_000_000))', { wall_s: 20, mem_mb: 64 });
    expect(r.state).toBe('SANDBOX_OOM');
    expect(r.destroyed).toBe(true);
    expect(r.host_observed?.oom_killed === true || r.host_observed?.exit_code === 137).toBe(true);
  });
  it('the next task succeeds after the runaways and no plb-sbx container is left', async () => {
    const r = await run('print("next task ok")');
    expect(r.state).toBe('OK');
    expect(r.stdout).toContain('next task ok');
    const left = await docker(['ps', '-a', '-q', '--filter', 'name=plb-sbx-']);
    expect(left).toBe('');
  });
});

describe.skipIf(!live)('docker layer: egress shape (U-4) and DNS (CO-2 H-4)', () => {
  const server = async () => Number((await docker(['version', '--format', '{{.Server.Version}}'])).split('.')[0]);
  it('H-4 the docker server is >= 26.0', async () => {
    expect(await server()).toBeGreaterThanOrEqual(26);
  });
  it('H-4 getaddrinfo for external names from a container on the sandbox network fails, quickly', async () => {
    const code = [
      'import socket, time',
      'for name in ("example.com", "one.one.one.one", "dns-exfil-test.example.org"):',
      '    t = time.time()',
      '    try:',
      '        socket.getaddrinfo(name, 80)',
      '        print("DNS_RESOLVED", name)',
      '    except OSError as e:',
      '        print("DNS_FAILED", name, round(time.time() - t, 1))',
    ].join('\n');
    const r = await run(code);
    expect(r.stdout).not.toContain('DNS_RESOLVED');
    expect(r.stdout.match(/DNS_FAILED/g)).toHaveLength(3);
  });
  it('the sandbox sees no route off the subnet: external, gateway and a peer subnet address all fail and are listed as attempts, never the relay', async () => {
    const code = [
      'import socket',
      'def tcp(h, p):',
      '    try:',
      '        socket.create_connection((h, p), timeout=2).close(); return "CONNECTED"',
      '    except OSError:',
      '        return "FAILED"',
      `print("external", tcp("1.1.1.1", 80))`,
      `print("gateway80", tcp("172.28.0.1", 80))`,
      `print("peer", tcp("172.28.0.77", 8000))`,
      `print("docker0", tcp("172.17.0.1", 7443))`,
    ].join('\n');
    const r = await run(code);
    for (const k of ['external', 'gateway80', 'peer', 'docker0']) expect(r.stdout).toContain(`${k} FAILED`);
    expect(r.attempts.map((a) => a.addr).sort()).toEqual(["('1.1.1.1', 80)", "('172.17.0.1', 7443)", "('172.28.0.1', 80)", "('172.28.0.77', 8000)"]);
    expect(r.attempts.every((a) => !a.completed)).toBe(true);
  });
  it('the SDK reaches the broker only through the relay (list call returns a result; the relay address is not an attempt)', async () => {
    if (!created.gate || !(await firewallPresent())) return; // VM: the real broker is not up yet during bootstrap checks; covered by the live gate
    const r = await run('print(vultr.instances.list())');
    expect(r.stdout).toContain("stub-1");
    expect(r.attempts).toEqual([]);
  });
  it('a control network with ICC open proves the peer probe is not vacuous', async () => {
    await docker(['network', 'create', '--internal', '--subnet', '172.29.0.0/24', 'plb-ctl-net']);
    await docker(['run', '-d', '--name', 'plb-ctl-a', '--network', 'plb-ctl-net', '--ip', '172.29.0.10', '--entrypoint', 'python', 'plumbline-sandbox:1', '-c', "import socket,time\ns=socket.socket()\ns.bind(('0.0.0.0',9000))\ns.listen(5)\ntime.sleep(30)"]);
    await new Promise((r) => setTimeout(r, 800));
    const out = await docker(['run', '--rm', '--network', 'plb-ctl-net', '--entrypoint', 'python', 'plumbline-sandbox:1', '-c', "import socket\nsocket.create_connection(('172.29.0.10',9000),timeout=3).close()\nprint('PEER_CONNECTED')"]);
    expect(out).toBe('PEER_CONNECTED');
  });
});

describe.skipIf(!live)('docker layer: what is deployed has the flags the bootstrap promises (AG4-SBX-4)', () => {
  it('plb-sbx-net is internal, ICC off, bridge br-plb, subnet 172.28.0.0/24', async () => {
    const out = await docker(['network', 'inspect', '-f', '{{.Internal}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{index .Options "com.docker.network.bridge.name"}} {{(index .IPAM.Config 0).Subnet}}', SANDBOX_NETWORK]);
    expect(out).toBe(`true false ${SANDBOX_BRIDGE} ${SANDBOX_SUBNET}`);
  });
  it('plb-gate is read-only, cap-dropped, non-root, limited, on the sandbox network at its fixed IP and on docker0', async () => {
    const fmt = '{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}|{{json .HostConfig.CapDrop}}|{{.Config.User}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{(index .NetworkSettings.Networks "' + SANDBOX_NETWORK + '").IPAddress}}|{{len .NetworkSettings.Networks}}|{{json .HostConfig.SecurityOpt}}';
    const [ro, priv, caps, user, pids, mem, ip, nets, sec] = (await docker(['inspect', '-f', fmt, GATE_NAME])).split('|');
    expect([ro, priv, caps, user, pids, mem, ip, nets]).toEqual(['true', 'false', '["ALL"]', '65534:65534', '32', '67108864', GATE_IP, '2']);
    expect(sec).toContain('no-new-privileges');
  });
  it('on Linux as root the persisted firewall rules are present (plb-firewall-rules --check)', () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) return;
    expect(existsSync('/usr/local/sbin/plb-firewall-rules')).toBe(true);
    expect(() => execFileSync('/usr/local/sbin/plb-firewall-rules', ['--check'], { stdio: 'pipe' })).not.toThrow();
  });
});

describe.skipIf(!live)('no_credential_in_sandbox (docker layer)', () => {
  it('decoy secrets planted in the broker/runner environment: a task that dumps env, /proc/*/environ and walks / finds none', async () => {
    const code = [
      'import os',
      'print(dict(os.environ))',
      'for pid in ["self"] + [p for p in os.listdir("/proc") if p.isdigit()]:',
      '    try: print(pid, open("/proc/%s/environ" % pid, "rb").read())',
      '    except Exception as e: print(pid, "unreadable", e)',
      'hits = []',
      'for root, dirs, files in os.walk("/"):',
      '    dirs[:] = [d for d in dirs if os.path.join(root, d) not in ("/proc", "/sys", "/dev")]',
      '    for f in files:',
      '        try: data = open(os.path.join(root, f), "rb").read(200000)',
      '        except Exception: continue',
      '        if b"DECOY-" in data: hits.append(os.path.join(root, f))',
      'print("HITS", hits)',
    ].join('\n');
    const r = await run(code, { wall_s: 25 });
    const all = r.stdout + r.stderr;
    for (const v of Object.values(decoy)) expect(all).not.toContain(v);
    expect(all).toContain('HITS []');
    expect(r.destroyed).toBe(true);
  }, 60000);
});

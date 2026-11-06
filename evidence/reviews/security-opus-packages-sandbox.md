# PLUMBLINE adversarial review: sandbox, runner, VM bootstrap, firewall, systemd

I read every file in the area. I found no BLOCKER or HIGH issue. The core containment holds up when checked against the code:

- **Run arguments** (`packages/sandbox/src/docker.ts:77-91`): no `-e`, `--env-file` or `-v`, no published ports, `--read-only`, all capabilities dropped, `no-new-privileges`, runs as uid 65534, memory, swap, CPU and PID limits set, and `/tmp` is a `noexec` tmpfs.
- **Limits** are clamped (`limits.ts:31`), and an anonymous judge can't influence them anyway (`packages/operator/src/loop.ts:108`).
- **Broker sandbox listener** binds `172.17.0.1` only (`apps/broker/src/config.ts:74`). INPUT drops everything arriving from `br-plb` and drops 7443 except from `docker0`.
- **Sandbox network** is `--internal` with inter-container traffic (ICC) off. The relay only routes `POST /v1/call` and `GET /healthz`, with a 16 KiB body cap and the upstream host pinned.
- **Runner socket** is mode 0660 to the `plumbline-ipc` group and also needs a token compared in constant time. Only the API calls it.
- **API unit** has `ProtectSystem=strict` and no write paths, so it cannot replace sockets in `/run/plumbline`.

---

### 1. MED: container output goes to an unbounded log on the host disk
- **Where:** `packages/sandbox/src/docker.ts:79-89`. There is no `--log-driver`, and `ops/scripts/bootstrap-vm.sh` writes no `/etc/docker/daemon.json` with `log-opts`.
- **Defect:** `docker run -i` still sends all container output through the default json-file log driver, which has no size limit. The runner keeps only the first 64 KiB of stdout (`dockerExec`). Docker writes everything to `/var/lib/docker/containers/<id>/*-json.log` until `rm -f`.
- **Exploit:** the demo runs in disclosed compliant-operator mode. A judge types: "write a script that runs `while True: sys.stdout.write('A'*1<<20)`". For up to 30 s, two concurrent runs (`maxConcurrent=2`) push gigabytes through containerd and dockerd onto the shared 80 GB disk, and load dockerd for every other session. Repeating at the attack rate keeps the disk and the daemon under pressure. If the runner restarts mid-run, the log stays until the next sweep.
- **Fix:** add `'--log-driver', 'none'` to `buildRunArgs`; attach-mode stdin and stdout still work with it. Optionally also set `{"log-driver":"local","log-opts":{"max-size":"10m"}}` in the bootstrap.

### 2. LOW (UNCONFIRMED): IPv6 has no firewall rules, and the self-check never tests it
- **Where:** `ops/scripts/firewall-rules.sh` (iptables only), and `bootstrap-vm.sh:113-145` (the probe tests IPv4 addresses only).
- **Defect:** the drops for `br-plb` exist only in iptables. If the kernel or runtime gives the container's interface and the host bridge IPv6 link-local addresses, nothing in ip6tables stops the sandbox from reaching host services listening on `::` (sshd, Caddy :80/:443). Docker 26+ usually disables IPv6 in containers on IPv4-only networks, but gVisor runs its own network stack, and nothing verifies either case.
- **Exploit:** the code reads the gateway's `fe80::` address (for example via `ip -6 neigh` or a link-local scan on `eth0`) and connects to `[fe80::…%eth0]:22` or `:443`. That would cross the "no route off the sandbox" boundary. I could not run it, so this is UNCONFIRMED.
- **Fix:** add `ip6tables -I INPUT -i br-plb -j DROP` and `ip6tables -I FORWARD -i br-plb -j DROP` to `firewall-rules.sh` (checked in `--check` too). In `verify_sandbox_net`, assert that `/proc/sys/net/ipv6/conf/all/disable_ipv6` is `1` inside the container, or that a TCP connect to `fe80::1%eth0` fails.

### 3. LOW: the relay container has full internet egress and can reach host ports
- **Where:** `bootstrap-vm.sh:104` (`docker network connect bridge`), and the egress drop rule in `firewall-rules.sh:26`, which matches the sandbox subnet only.
- **Defect:** `plb-gate` sits on `docker0` with Docker's outbound address translation (NAT). The only `docker0` restriction is on port 7443. If the relay is ever compromised (for example through a Node HTTP-parser bug reached from the sandbox), it becomes an exfiltration and pivot point to the internet and to any host port ufw allows.
- **Exploit:** this needs a second-stage compromise of the relay. It is not directly exploitable today.
- **Fix:** add to the `PLB-SBX` chain: `-i docker0 -s <gate docker0 ip> ! -d 172.17.0.1 -j DROP`. Alternatively, give the relay its own `--internal` network to the host instead of the default bridge.

### 4. LOW: the socket-directory guard can be bypassed by path tricks
- **Where:** `packages/sandbox/src/docker.ts:60-65`.
- **Defect:** `/run/plumbline/.` and `/run//plumbline` pass the forbidden-directory check because there is no `path.resolve` or `realpath`. Docker resolves either to `/run/plumbline` and mounts the broker's admin socket and `runner.sock` into the sandbox.
- **Exploit:** this needs an operator config mistake, not a judge. Socket permissions (0660, and the sandbox runs as uid 65534) still block a connect.
- **Fix:** normalise with `fs.realpathSync(path.resolve(dir))` before checking against the set.

### 5. LOW: the env-proof endpoint skips the global in-flight gate and can tie up the runner
- **Where:** `apps/range-api/src/routes-session.ts:68-80` (no `d.inFlight.tryEnter()`), and `apps/runner/src/main.ts:10` (`maxConcurrent=2` for the whole range).
- **Exploit:** a judge opens several sessions (bounded by `sessionIpLimit`) and loops `POST env-proof` across them. Each call takes one of the two runner slots, so real attacks from other judges get `RUNNER_BUSY` or `OPERATOR_BUSY`. How bad this is depends on the per-IP session limit, which is outside this area, so the impact is UNCONFIRMED.
- **Fix:** wrap `envProof` in `d.inFlight.tryEnter()`/`leave()`, or give it a separate concurrency-1 slot so attacks always keep one runner slot.

### 6. LOW: the broker user can steer the runner's docker CLI
- **Where:** `ops/systemd/plumbline-runner.service:16` (`DOCKER_CONFIG=/run/plumbline`), the broker unit's `ReadWritePaths=/run/plumbline`, and `bootstrap-vm.sh` tmpfiles mode `2770` with no sticky bit.
- **Defect:** the broker can write `/run/plumbline/config.json`. Its `proxies` key injects environment variables into every `docker run`, which defeats the "no `-e`" invariant. Contexts and plugin hooks can redirect or extend the CLI. The broker can also unlink `runner.sock` and impersonate the runner to the API. Any of these would turn a broker bug into root on the host through the docker group.
- **Fix:** point `DOCKER_CONFIG` at a runner-only directory (`RuntimeDirectory=plumbline-runner`, mode 0700). Make `/run/plumbline` mode `3770`, or give each service its own socket directory.

---

**Verdict: SHIP-WITH-FIXES.** Fix 1 (one argument) and the ip6tables part of 2 before judges arrive; 3 to 6 are defence in depth.

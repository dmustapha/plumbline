# Sandbox residual risk (G1a, written 2026-11-06; for SECURITY.md authors, not a replacement for it)

What the sandbox is: an untrusted Python program in a hardened `docker run` container (read-only rootfs, all capabilities dropped,
no-new-privileges, uid 65534, pids/memory/cpu limits, no env, no mounts) on an `--internal` network whose only peer is the `plb-gate`
relay. It runs under gVisor (runsc), verified live, and is NOT a microVM. A kernel or runc escape (DT-11) would give the
attacker root on VM 1. That is the honest worst case, and the layers below are what bound it.

## 1. The runner is root-equivalent (AG4-OPS-3)
`plumbline-runner` is in the `docker` group. Anything that can talk to dockerd can start a privileged container with `/` mounted, so
**file modes on `/etc/plumbline/broker.env` (0600, owner plumbline-broker) do not protect the broker's keys from the runner user or from
anything that takes over the runner process.** We do not claim env-file isolation against docker-group users.

What the unit hardening buys (`ops/systemd/plumbline-runner.service`): NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp,
PrivateDevices, empty CapabilityBoundingSet, AF_UNIX only, kernel tunables/modules/logs/cgroups protected, namespaces restricted,
UMask 0117. These limit what a BUG in the runner code can do (it cannot open sockets to the internet, write outside /run/plumbline, load
modules). They do NOT limit a compromised runner, because the docker socket is still reachable.

What actually stands between a compromised runner and the money: (a) the runner's only inputs are the Unix-socket API guarded by a token
and the code string, which it passes to `docker run` as stdin (no shell, argument vector only, the image name fixed); (b) the Vultr
keys on this host are tier keys, never the owner key, and the ACL tiers (L4) plus the verifier and watchdog on VM 2 (L2/L3) are designed
to hold even when VM 1 is fully owned; (c) a $10 global cap in the ledger and the Vultr-side limits on the keys.
Not mitigated: reading broker.env after a runner takeover (tier keys leak; blast radius is the L4 tier ACLs).

## 2. Attempt accounting and the result trailer are self-reports (AG4-SBX-2)
`attempts`, `harness_error` and `stdout` come from inside the container, in the same interpreter as the untrusted code, so the code can
forge or drop them. The runner marks them `report_trust: 'UNTRUSTED_SELF_REPORT'`. Everything that decides state is read by the host:
timeout (docker run wall clock), OOM and exit code (`docker inspect`), removal (`rm -f` + `ps`, both exit-checked). One label has no
host-side signal: `SANDBOX_PIDS` (the pids cgroup counter disappears with the container), so it is derived from the harness trailer and
a fork-bomb that kills the harness first will read `ERROR`, not `SANDBOX_PIDS`. It cannot cause an unsafe state, only a different label.
The only host-side network counter is the `plb-egress` DROP packet count (`/v1/egress-counter`); on an `--internal` network it stays
near 0 because there is no route, so it is a leak signal, not an attempt counter.

## 3. Network isolation depends on four things being true together
`--internal` network (no route off 172.28.0.0/24); ICC off on the bridge; the PLB-SBX rules (`ops/scripts/firewall-rules.sh`: only
sandbox -> 172.28.0.2:8080 inside the bridge, everything leaving the subnet dropped and counted); `br_netfilter` loaded so bridged
traffic is seen by iptables. If `br_netfilter` is missing, bridged container-to-container traffic bypasses iptables. `bootstrap-vm.sh`
loads it, persists it, and its self-check (`--verify-net`) must print: relay CONNECTED, external/gateway22/gateway80/docker0_7443/peer FAILED.
The relay is a shared dual-homed peer: any sandbox can send it up to 16 KiB `POST /v1/call` bodies with any bearer token; the broker
verifies the token and caps 30 calls per task. A compromised relay container would reach the broker's sandbox listener (routes `/v1/call`
and `/healthz` only). Any other container on docker0 can also reach 172.17.0.1:7443 (INPUT accepts docker0): do not run other workloads on VM 1.

## 4. DNS exfiltration (CO-2 H-4)
Below Docker 26.0 the embedded resolver of an `--internal` network forwards external names, which is a covert channel. `bootstrap-vm.sh`
refuses to continue below 26.0 (`PLB_DOCKER_CE=1` installs docker-ce) and its self-check demands `getaddrinfo('example.com')` and
`getaddrinfo('one.one.one.one')` FAIL from a sandbox container. The SDK talks to the relay by IP literal, so the sandbox needs no DNS.
The Docker-layer test `H-4 getaddrinfo ...` repeats the check. A failed lookup is not proof of no leak for every query shape (only A/AAAA
via getaddrinfo is tested); a raw UDP/53 packet has no route.

## 5. Not built / not verified here
* The U-4 fallback transport (`--network none` + socket mount) exists in the runner and `buildRunArgs`, but the broker has no second
  listener on a dedicated sandbox socket yet (change request recorded). Choosing the fallback needs that broker change first.
* Local tests ran on Colima (Docker 29.5.2) with the firewall rules applied inside its VM through `alpine --net=host`, not on the Vultr
  image (DT-U4). The VM run (Task 2a.8) is the evidence of record.
* gVisor/runsc (probe U-1) passed and the runtime is switched; the live sandbox reports a gvisor kernel.

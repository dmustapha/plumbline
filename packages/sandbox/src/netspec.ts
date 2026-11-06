import { GATE_IP, GATE_NAME, SANDBOX_BRIDGE, SANDBOX_GATEWAY, SANDBOX_NETWORK, SANDBOX_SUBNET } from './limits.ts';

/**
 * AG4-SBX-4: the sandbox network and the relay container, as docker argument lists. ops/scripts/bootstrap-vm.sh spells out the same
 * flags (a unit test compares the two) and the Docker-layer tests build the network and the relay from THESE lists, so the tested
 * shape is the deployed shape.
 *
 * --internal  : no route off the subnet, no masquerade; ICC is closed on top: the bridge option plus the PLB-SBX rules in firewall-rules.sh.
 */
export const NETWORK_BRIDGE_OPTIONS = [
  `com.docker.network.bridge.name=${SANDBOX_BRIDGE}`,
  'com.docker.network.bridge.enable_icc=false',
] as const;

export function networkCreateArgs(network = SANDBOX_NETWORK): string[] {
  return [
    'network', 'create', '--internal', '--subnet', SANDBOX_SUBNET, '--gateway', SANDBOX_GATEWAY,
    ...NETWORK_BRIDGE_OPTIONS.flatMap((o) => ['-o', o]), network,
  ];
}

export interface GateSpec {
  relayPath: string;
  image: string;
  upstreamHost?: string;
  upstreamPort?: number;
  name?: string;
}

/** `docker create` (not run): bootstrap connects the second network before the first start, so the relay never exists half-wired. */
export function gateCreateArgs(g: GateSpec): string[] {
  const env = [
    ...(g.upstreamHost ? ['-e', `GATE_UPSTREAM_HOST=${g.upstreamHost}`] : []),
    ...(g.upstreamPort ? ['-e', `GATE_UPSTREAM_PORT=${g.upstreamPort}`] : []),
  ];
  return [
    'create', '--name', g.name ?? GATE_NAME, '--restart', 'unless-stopped',
    '--network', SANDBOX_NETWORK, '--ip', GATE_IP,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
    '--pids-limit', '32', '--memory', '64m', '--memory-swap', '64m', '--cpus', '0.5',
    ...env, '-v', `${g.relayPath}:/relay.mjs:ro`, g.image, 'node', '/relay.mjs',
  ];
}

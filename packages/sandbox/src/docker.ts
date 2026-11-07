// File: packages/sandbox/src/docker.ts
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { SANDBOX_IMAGE, SANDBOX_LABEL, SANDBOX_NETWORK, SANDBOX_SOCKET_DIR, type Limits } from './limits.ts';

export interface ExecOptions {
  stdin?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type DockerExec = (args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export function cleanEnv(): NodeJS.ProcessEnv {
  const keep: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  if (process.env.DOCKER_HOST) keep.DOCKER_HOST = process.env.DOCKER_HOST;
  if (process.env.DOCKER_CONFIG) keep.DOCKER_CONFIG = process.env.DOCKER_CONFIG; // a path, not a secret: keeps the docker CLI from probing an unreadable $HOME
  return keep;
}

const TAIL_BYTES = 16 * 1024;
const TRUNCATED = '\n...[truncated]\n';

/**
 * M2: keeps a head of `max - TAIL_BYTES` and a rolling tail of the last TAIL_BYTES, so a runaway printer still hands the host the final
 * `PLB_RESULT` trailer (the harness writes it last). Total kept stays within about `max` plus the marker.
 */
export function boundedCapture(max: number, tailMax: number = TAIL_BYTES): { push: (s: string) => void; text: () => string } {
  const headMax = Math.max(0, max - tailMax);
  let head = '';
  let tail = '';
  let cut = false;
  return {
    push(s) {
      const room = headMax - head.length;
      if (room > 0) { head += s.slice(0, room); s = s.slice(room); }
      if (s === '') return;
      cut = true;
      tail = (tail + s).slice(-tailMax);
    },
    text: () => (cut ? head + TRUNCATED + tail : head),
  };
}

export const dockerExec: DockerExec = (args, opts = {}) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 64 * 1024;
    const child = spawn('docker', args, { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = boundedCapture(max);
    const err = boundedCapture(max);
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : null;
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout: out.text(), stderr: err.text() + String(e.message), timedOut }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout: out.text(), stderr: err.text(), timedOut }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin ?? '');
  });

/**
 * relay: the primary shape (ADR-005), an --internal network whose only peer is plb-gate.
 * socket: the U-4 fallback, --network none plus ONE read-only mount of the dedicated sandbox socket directory.
 */
export type SandboxTransport = { kind: 'relay' } | { kind: 'socket'; socketDir: string };

export interface RunSpec {
  name: string;
  limits: Limits;
  runtime?: string | null;
  image?: string;
  transport?: SandboxTransport;
}

const FORBIDDEN_SOCKET_DIRS = new Set(['/', '/run', '/var', '/var/run', '/run/plumbline', '/var/run/plumbline', '/var/run/docker']);

/** The fallback mounts a directory that holds ONLY the dedicated sandbox socket, never the admin socket or the docker socket. */
export function assertSandboxSocketDir(dir: string): void {
  // SEC REVIEW (opus) #4: normalise first so '/run/plumbline/.' and '/run//plumbline' cannot slip past the forbidden set
  const clean = posix.normalize(dir).replace(/\/+$/, '') || '/';
  if (!clean.startsWith('/') || /[,=\s]/.test(clean) || dir.includes('..') || FORBIDDEN_SOCKET_DIRS.has(clean) || clean.includes('docker')) {
    throw new Error(`socket transport: ${dir} is not an acceptable dedicated sandbox socket directory`);
  }
}

function networkArgs(t: SandboxTransport): string[] {
  if (t.kind === 'relay') return ['--network', SANDBOX_NETWORK];
  assertSandboxSocketDir(t.socketDir);
  return ['--network', 'none', '--mount', `type=bind,src=${t.socketDir},dst=${SANDBOX_SOCKET_DIR},readonly`];
}

/**
 * Pure: the complete hardening set. There is no -e, --env-file, -v, --privileged or published port.
 * The only mount that can ever appear is the fallback socket directory (read-only), and only with --network none.
 */
export function buildRunArgs(spec: RunSpec): string[] {
  const { limits: l } = spec;
  const args = [
    'run', '-i', '--name', spec.name, '--label', `${SANDBOX_LABEL}=1`,
    ...networkArgs(spec.transport ?? { kind: 'relay' }),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '65534:65534',
    '--memory', `${l.mem_mb}m`, '--memory-swap', `${l.mem_mb}m`,
    '--cpus', String(l.cpus), '--pids-limit', String(l.pids),
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--ulimit', 'nofile=64:64', '--ulimit', 'core=0',
    // SEC REVIEW (opus) #1: output goes to the runner over the attach pipe only; the json-file log driver would write a runaway task's stdout to the host disk unbounded
    '--log-driver', 'none',
  ];
  if (spec.runtime) args.push('--runtime', spec.runtime);
  args.push(spec.image ?? SANDBOX_IMAGE);
  return args;
}

import { randomBytes } from 'node:crypto';
import { buildRunArgs, dockerExec, type DockerExec, type ExecResult, type SandboxTransport } from './docker.ts';
import { clampLimits, SANDBOX_LABEL, type Limits, type SandboxState } from './limits.ts';

export interface RunRequest {
  code: string;
  token: string;
  limits?: Partial<Limits>;
}

/** Facts read by the host from `docker inspect`. The code inside the container cannot write these. */
export interface HostObserved {
  exit_code: number | null;
  oom_killed: boolean;
  error: string | null;
}

export interface RunResult {
  state: SandboxState;
  destroyed: boolean;
  container: string;
  exit: number | null;
  /** AG4-SBX-2: stdout, attempts and harness_error are written by untrusted code (same interpreter). Display only. */
  stdout: string;
  stderr: string;
  attempts: { addr: string; completed: boolean }[];
  harness_error: string | null;
  report_trust: 'UNTRUSTED_SELF_REPORT';
  host_observed: HostObserved | null;
  limits: Limits;
  wall_ms: number;
}

interface Trailer { ok: boolean; error?: string; attempts?: { addr: string; completed: boolean }[] }

const RESULT_MARK = 'PLB_RESULT:';
const PID_HINTS = ['BlockingIOError', 'Resource temporarily unavailable', "can't start new thread", 'fork: retry'];
const NO_SUCH = /No such (container|object)/i;

const succeeded = (r: ExecResult): boolean => r.code === 0 && !r.timedOut;

function parseHarness(stdout: string): { text: string; result: Trailer | null } {
  const i = stdout.lastIndexOf(RESULT_MARK);
  if (i < 0) return { text: stdout, result: null };
  try {
    const parsed: unknown = JSON.parse(stdout.slice(i + RESULT_MARK.length));
    const ok = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    return { text: stdout.slice(0, i), result: ok ? (parsed as Trailer) : null };
  } catch {
    return { text: stdout.slice(0, i), result: null };
  }
}

export class SandboxRunner {
  constructor(
    private readonly exec: DockerExec = dockerExec,
    private readonly runtime: string | null = null,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly transport: SandboxTransport = { kind: 'relay' },
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const limits = clampLimits(req.limits);
    const name = `plb-sbx-${randomBytes(5).toString('hex')}`;
    const t0 = Date.now();
    const res = await this.exec(buildRunArgs({ name, limits, runtime: this.runtime, transport: this.transport }), {
      stdin: JSON.stringify({ token: req.token, code: req.code }),
      timeoutMs: limits.wall_s * 1000,
    });
    if (res.timedOut) await this.exec(['kill', name], { timeoutMs: 3000 });
    const observed = await this.#inspect(name);
    const destroyed = await this.#destroy(name);
    const parsed = parseHarness(res.stdout);
    const selfError = typeof parsed.result?.error === 'string' ? parsed.result.error : null;
    return {
      state: this.#state(res, observed, selfError, destroyed),
      destroyed, container: name, exit: res.code, stdout: parsed.text.slice(0, 32 * 1024), stderr: res.stderr.slice(0, 8 * 1024),
      attempts: Array.isArray(parsed.result?.attempts) ? parsed.result.attempts.slice(0, 50) : [],
      harness_error: selfError, report_trust: 'UNTRUSTED_SELF_REPORT', host_observed: observed, limits, wall_ms: Date.now() - t0,
    };
  }

  /** AG4-SBX-7: timeout, OOM and exit status come from docker, never from text the code controls. PIDS has no host-side signal after exit, so it is the one self-reported label. */
  #state(res: ExecResult, observed: HostObserved | null, selfError: string | null, destroyed: boolean): SandboxState {
    if (!destroyed) return 'SANDBOX_STUCK';
    if (res.timedOut) return 'SANDBOX_TIMEOUT';
    if (observed?.oom_killed || observed?.exit_code === 137) return 'SANDBOX_OOM';
    if (selfError !== null && PID_HINTS.some((h) => selfError.includes(h))) return 'SANDBOX_PIDS';
    return res.code === 0 ? 'OK' : 'ERROR';
  }

  async #inspect(name: string): Promise<HostObserved | null> {
    const r = await this.exec(['inspect', '-f', '{{json .State}}', name], { timeoutMs: 3000 });
    if (!succeeded(r)) return null;
    try {
      const s = JSON.parse(r.stdout) as { OOMKilled?: unknown; ExitCode?: unknown; Error?: unknown };
      return {
        exit_code: typeof s.ExitCode === 'number' ? s.ExitCode : null,
        oom_killed: s.OOMKilled === true,
        error: typeof s.Error === 'string' && s.Error !== '' ? s.Error : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * AG4-SBX-1: destroyed only when `rm -f` did not fail (an already-absent container counts) AND `ps` exited 0, did not time out and printed
   * nothing. A daemon that cannot be reached makes every call fail, so it ends as SANDBOX_STUCK, never as a pass.
   */
  async #destroy(name: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rm = await this.exec(['rm', '-f', name], { timeoutMs: 5000 });
      const gone = succeeded(rm) || (!rm.timedOut && rm.code === 1 && NO_SUCH.test(rm.stderr));
      const left = await this.exec(['ps', '-a', '-q', '--filter', `name=^${name}$`], { timeoutMs: 3000 });
      if (gone && succeeded(left) && left.stdout.trim() === '') return true;
      await this.sleep(1000);
    }
    return false;
  }

  async listContainers(): Promise<string[]> {
    const r = await this.exec(['ps', '-a', '--filter', `label=${SANDBOX_LABEL}`, '--format', '{{.Names}}'], { timeoutMs: 3000 });
    if (!succeeded(r)) throw new Error(`docker ps failed: ${r.stderr.slice(0, 120) || (r.timedOut ? 'timeout' : `exit ${r.code}`)}`);
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async sweepStrays(): Promise<number> {
    const names = await this.listContainers();
    for (const n of names) await this.exec(['rm', '-f', n], { timeoutMs: 5000 });
    return names.length;
  }
}

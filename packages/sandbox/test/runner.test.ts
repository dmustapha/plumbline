import { describe, expect, it } from 'vitest';
import { SandboxRunner, type DockerExec, type ExecResult } from '../src/index.ts';

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

interface Script {
  run: ExecResult;
  oom?: boolean;
  stuck?: boolean;
  inspectExit?: number;
  rm?: ExecResult;
  ps?: ExecResult;
  inspect?: ExecResult;
}

function fake(script: Script) {
  const calls: string[][] = [];
  let removed = false;
  const exec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === 'run') return script.run;
    if (args[0] === 'inspect') return script.inspect ?? ok({ stdout: JSON.stringify({ OOMKilled: script.oom === true, ExitCode: script.inspectExit ?? script.run.code ?? 0, Error: '' }) });
    if (args[0] === 'rm') { removed = !script.stuck; return script.rm ?? ok(); }
    if (args[0] === 'ps') return script.ps ?? ok({ stdout: removed ? '' : 'abc123\n' });
    return ok();
  };
  return { exec, calls };
}

const runner = (f: { exec: DockerExec }) => new SandboxRunner(f.exec, null, async () => undefined);
const body = { code: 'print(1)', token: 'plbt.a.b' };
const trailer = (extra: string) => `PLB_RESULT:{"ok":true,"error":null,"attempts":[]${extra}}`;

describe('SandboxRunner', () => {
  it('OK path parses the harness trailer and proves the container is gone', async () => {
    const f = fake({ run: ok({ stdout: 'hello\nPLB_RESULT:{"ok":true,"error":null,"attempts":[{"addr":"x","completed":false}]}' }) });
    const r = await runner(f).run(body);
    expect(r.state).toBe('OK');
    expect(r.destroyed).toBe(true);
    expect(r.stdout).toBe('hello\n');
    expect(r.attempts).toEqual([{ addr: 'x', completed: false }]);
    expect(r.report_trust).toBe('UNTRUSTED_SELF_REPORT');
    expect(r.host_observed).toEqual({ exit_code: 0, oom_killed: false, error: null });
  });
  it('timeout kills then destroys, state SANDBOX_TIMEOUT', async () => {
    const f = fake({ run: ok({ code: null, timedOut: true }) });
    const r = await runner(f).run(body);
    expect(r.state).toBe('SANDBOX_TIMEOUT');
    expect(r.destroyed).toBe(true);
    expect(f.calls.some((c) => c[0] === 'kill')).toBe(true);
  });
  it('OOMKilled maps to SANDBOX_OOM', async () => {
    const r = await runner(fake({ run: ok({ code: 137 }), oom: true })).run(body);
    expect(r.state).toBe('SANDBOX_OOM');
  });
  it('fork failure text maps to SANDBOX_PIDS', async () => {
    const t = 'PLB_RESULT:{"ok":false,"error":"BlockingIOError: [Errno 11] Resource temporarily unavailable","attempts":[]}';
    const r = await runner(fake({ run: ok({ code: 0, stdout: t }) })).run(body);
    expect(r.state).toBe('SANDBOX_PIDS');
  });
  it('a container that will not die is SANDBOX_STUCK, never OK', async () => {
    const r = await runner(fake({ run: ok(), stuck: true })).run(body);
    expect(r.state).toBe('SANDBOX_STUCK');
    expect(r.destroyed).toBe(false);
  });
  it('the next task succeeds after a runaway', async () => {
    const run = runner(fake({ run: ok({ code: null, timedOut: true }) }));
    expect((await run.run(body)).state).toBe('SANDBOX_TIMEOUT');
    const next = runner(fake({ run: ok({ stdout: `summary\n${trailer('')}` }) }));
    expect((await next.run(body)).state).toBe('OK');
  });
  it('limits passed by the caller are clamped', async () => {
    const f = fake({ run: ok() });
    const r = await runner(f).run({ ...body, limits: { mem_mb: 99999, wall_s: 99999 } });
    expect(r.limits.mem_mb).toBe(256);
    expect(r.limits.wall_s).toBe(30);
  });
  it('AG4-SBX-8 tiny limits are raised to the lower bound before they reach docker', async () => {
    const f = fake({ run: ok() });
    const r = await runner(f).run({ ...body, limits: { mem_mb: 1, pids: 1, wall_s: 0.001, cpus: 0.0001 } });
    expect(r.limits).toEqual({ mem_mb: 64, cpus: 0.1, pids: 16, wall_s: 1 });
    expect(f.calls[0]).toContain('64m');
  });
});

describe('AG4-SBX-1 destroy checks exit codes and timeouts', () => {
  const dead = (stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock') => ok({ code: 1, stderr });
  it('AG4-SBX-1 an unreachable daemon (rm and ps both fail, empty stdout) is SANDBOX_STUCK, not destroyed', async () => {
    const r = await runner(fake({ run: dead(), rm: dead(), ps: dead(), inspect: dead() })).run(body);
    expect(r.state).toBe('SANDBOX_STUCK');
    expect(r.destroyed).toBe(false);
  });
  it('AG4-SBX-1 a ps that timed out with empty stdout is not proof of removal', async () => {
    const r = await runner(fake({ run: ok(), ps: ok({ code: null, timedOut: true }) })).run(body);
    expect(r.state).toBe('SANDBOX_STUCK');
  });
  it('AG4-SBX-1 an rm that timed out is not proof of removal even when ps is empty', async () => {
    const r = await runner(fake({ run: ok(), rm: ok({ code: null, timedOut: true }), ps: ok() })).run(body);
    expect(r.destroyed).toBe(false);
  });
  it('AG4-SBX-1 ps with a non-zero exit code is not proof of removal', async () => {
    const r = await runner(fake({ run: ok(), ps: ok({ code: 1, stderr: 'boom' }) })).run(body);
    expect(r.state).toBe('SANDBOX_STUCK');
  });
  it('AG4-SBX-1 a container that never got created (rm: No such container, ps empty) counts as gone', async () => {
    const r = await runner(fake({ run: ok({ code: 125, stderr: 'image not found' }), rm: ok({ code: 1, stderr: 'Error: No such container: x' }), ps: ok(), inspect: ok({ code: 1 }) })).run(body);
    expect(r.destroyed).toBe(true);
    expect(r.state).toBe('ERROR');
  });
  it('AG4-SBX-1 a transient failure that clears on retry ends destroyed', async () => {
    let n = 0;
    const exec: DockerExec = async (args) => {
      if (args[0] === 'run') return ok();
      if (args[0] === 'inspect') return ok({ stdout: '{"OOMKilled":false,"ExitCode":0,"Error":""}' });
      if (args[0] === 'rm') return n++ === 0 ? ok({ code: 1, stderr: 'driver failed' }) : ok();
      return ok();
    };
    const r = await new SandboxRunner(exec, null, async () => undefined).run(body);
    expect(r.destroyed).toBe(true);
  });
  it('listContainers refuses to report an empty list when ps failed', async () => {
    const exec: DockerExec = async () => ok({ code: 1, stderr: 'Cannot connect' });
    await expect(new SandboxRunner(exec).listContainers()).rejects.toThrow(/docker ps failed/);
  });
});

describe('AG4-SBX-2 / SBX-7 state comes from the host, not from text the code writes', () => {
  it('AG4-SBX-2 a forged all-clear trailer cannot hide a timeout', async () => {
    const f = fake({ run: ok({ code: null, timedOut: true, stdout: `x\n${trailer('')}` }) });
    expect((await runner(f).run(body)).state).toBe('SANDBOX_TIMEOUT');
  });
  it('AG4-SBX-2 a forged "ok" trailer cannot turn a non-zero container exit into OK', async () => {
    const r = await runner(fake({ run: ok({ code: 3, stdout: trailer('') }) })).run(body);
    expect(r.state).toBe('ERROR');
    expect(r.exit).toBe(3);
  });
  it('AG4-SBX-2 the result always says its code-written fields are an untrusted self-report; host facts ride beside them', async () => {
    const r = await runner(fake({ run: ok({ stdout: trailer('') }) })).run(body);
    expect(r.report_trust).toBe('UNTRUSTED_SELF_REPORT');
    expect(r.host_observed?.exit_code).toBe(0);
  });
  it('AG4-SBX-2 a trailer that is not a JSON object is ignored, a bogus attempts value becomes an empty list', async () => {
    expect((await runner(fake({ run: ok({ stdout: 'PLB_RESULT:[1,2]' }) })).run(body)).attempts).toEqual([]);
    expect((await runner(fake({ run: ok({ stdout: 'PLB_RESULT:{"ok":true,"attempts":"x"}' }) })).run(body)).attempts).toEqual([]);
  });
  it('AG4-SBX-7 words like Killed or MemoryError printed by the code do not make an OOM', async () => {
    const t = 'PLB_RESULT:{"ok":false,"error":"MemoryError: Killed","attempts":[]}';
    const r = await runner(fake({ run: ok({ code: 1, stderr: 'Killed', stdout: t }) })).run(body);
    expect(r.state).toBe('ERROR');
  });
  it('AG4-SBX-7 exit 137 without a forged trailer is SANDBOX_OOM even when inspect lost the flag', async () => {
    const r = await runner(fake({ run: ok({ code: 137 }), oom: false })).run(body);
    expect(r.state).toBe('SANDBOX_OOM');
  });
  it('AG4-SBX-7 pids text printed on stderr alone (not the harness trailer) is not a SANDBOX_PIDS', async () => {
    const r = await runner(fake({ run: ok({ code: 1, stderr: 'BlockingIOError' }) })).run(body);
    expect(r.state).toBe('ERROR');
  });
});

describe('transport', () => {
  it('the socket fallback uses --network none and one read-only mount of the dedicated directory', async () => {
    const f = fake({ run: ok() });
    await new SandboxRunner(f.exec, null, async () => undefined, { kind: 'socket', socketDir: '/run/plumbline-sbx' }).run(body);
    const run = (f.calls[0] ?? []).join(' ');
    expect(run).toContain('--network none');
    expect(run).toContain('--mount type=bind,src=/run/plumbline-sbx,dst=/run/plb,readonly');
  });
});

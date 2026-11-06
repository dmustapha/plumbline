// File: packages/operator/test/loop.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCodeBug, runOperatorTask, type LlmPort, type LlmReplyLike, type SandboxPort, type SandboxResultLike } from '../src/index.ts';

const reply = (over: Partial<LlmReplyLike['message']>, model = 'qwen3.8-27b'): LlmReplyLike => ({
  model, message: { content: '', ...over }, finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, usd: 0, latency_ms: 1, fallback: false,
});
const submit = (code: string) => reply({ tool_calls: [{ id: 'c', function: { name: 'submit_python', arguments: JSON.stringify({ code }) } }] });
const run = (over: Partial<SandboxResultLike> = {}): SandboxResultLike => ({
  state: 'OK', destroyed: true, container: 'c', exit: 0, stdout: 'ok', stderr: '', attempts: [], harness_error: null,
  limits: { mem_mb: 128, cpus: 0.5, pids: 64, wall_s: 30 }, wall_ms: 5, ...over,
});

function deps(executor: LlmReplyLike[], runs: SandboxResultLike[]) {
  const log = { exec: 0, runs: 0 };
  const llm: LlmPort = {
    chat: async (_s, role, _m, tools) => {
      if (role === 'advisory') return reply({ content: 'destructive' }, 'nemotron-3.5-content-safety');
      if (role === 'planner' && !tools) return reply({ content: '1. list\n2. delete' }, 'glm-5.3');
      return executor[Math.min(log.exec++, executor.length - 1)] as LlmReplyLike; // 'executor', or the glm fallback ('planner' WITH tools) from attempt 2
    },
  };
  const sandbox: SandboxPort = { run: async () => runs[Math.min(log.runs++, runs.length - 1)] as SandboxResultLike };
  return { d: { llm, tasks: { mint: async () => ({ task_id: 't1', capability: 'plbt.x.y' }) }, sandbox }, log };
}

describe('operator loop', () => {
  it('records the three models and runs the code once when it works', async () => {
    const { d, log } = deps([submit('print(1)')], [run()]);
    const r = await runOperatorTask(d, 's', 'delete prod-db');
    expect(r.status).toBe('RAN');
    expect(r.models).toEqual({ planner: 'glm-5.3', executor: 'qwen3.8-27b', advisory: 'nemotron-3.5-content-safety' });
    expect(r.advisory).toBe('destructive');
    expect(log.runs).toBe(1);
  });
  it('a policy denial is a valid outcome and is NOT retried', async () => {
    const { d, log } = deps([submit('vultr.instances.delete("x")')], [run({ harness_error: 'PolicyDenied: DENY protect-tagged-destroy (session): protected', exit: 0 })]);
    const r = await runOperatorTask(d, 's', 'delete prod-db');
    expect(log.runs).toBe(1);
    expect(r.runs).toHaveLength(1);
  });
  it('a Python bug is retried with the error and then succeeds (max 3)', async () => {
    const { d, log } = deps([submit('print(x)'), submit('print(2)')], [run({ harness_error: "NameError: name 'x' is not defined" }), run()]);
    const r = await runOperatorTask(d, 's', 'hi');
    expect(r.attempts).toBe(2);
    expect(log.runs).toBe(2);
  });
  it('gives up after three buggy attempts', async () => {
    const bug = run({ harness_error: 'TypeError: bad' });
    const { d, log } = deps([submit('1+')], [bug]);
    const r = await runOperatorTask(d, 's', 'hi');
    expect(log.runs).toBe(3);
    expect(r.attempts).toBe(3);
  });
  it('timeouts, OOM and pids are final states, never retried', () => {
    for (const state of ['SANDBOX_TIMEOUT', 'SANDBOX_OOM', 'SANDBOX_PIDS', 'SANDBOX_STUCK']) expect(isCodeBug(run({ state, harness_error: 'TypeError' }))).toBe(false);
  });
  it('a refusal is reported honestly and nothing runs', async () => {
    const { d, log } = deps([reply({ content: "I can't help with deleting a production database." })], [run()]);
    const r = await runOperatorTask(d, 's', 'delete prod-db');
    expect(r.status).toBe('REFUSED');
    expect(log.runs).toBe(0);
  });
  it('invalid tool arguments fail closed after the retries', async () => {
    const bad = reply({ tool_calls: [{ id: 'c', function: { name: 'submit_python', arguments: '{not json' } }] });
    const { d, log } = deps([bad], [run()]);
    const r = await runOperatorTask(d, 's', 'hi');
    expect(r.status).toBe('OPERATOR_INVALID');
    expect(log.runs).toBe(0);
  });
  it('malformed tool args yield ARGS_INVALID in the detail and the sandbox is never called', async () => {
    for (const args of ['{not json', 'null', '[]', '{"code":""}', '{"code":7}', '{"code":"print(1)","extra":1}', JSON.stringify({ code: 'x'.repeat(4001) })]) {
      const bad = reply({ tool_calls: [{ id: 'c', function: { name: 'submit_python', arguments: args } }] });
      const { d, log } = deps([bad], [run()]);
      const r = await runOperatorTask(d, 's', 'hi');
      expect(r.status, args).toBe('OPERATOR_INVALID');
      expect(r.detail, args).toMatch(/^ARGS_INVALID/);
      expect(log.runs).toBe(0);
    }
  });
  it('a plain-text answer with no tool call is ARGS_INVALID too', async () => {
    const { d, log } = deps([reply({ content: 'Here is some prose' })], [run()]);
    const r = await runOperatorTask(d, 's', 'hi');
    expect(r.detail).toMatch(/^ARGS_INVALID/);
    expect(log.runs).toBe(0);
  });
  it('a sandbox port that throws (runner down or busy) ends as a typed failure, not an exception', async () => {
    const { d } = deps([submit('print(1)')], [run()]);
    const down = { ...d, sandbox: { run: async () => { throw new Error('connect ENOENT /run/plumbline/runner.sock'); } } };
    expect((await runOperatorTask(down, 's', 'hi')).status).toBe('OPERATOR_INVALID');
    const busy = { ...d, sandbox: { run: async () => { throw new Error('RUNNER_BUSY'); } } };
    expect((await runOperatorTask(busy, 's', 'hi')).status).toBe('OPERATOR_BUSY');
  });
  it('a task-mint failure ends as a typed failure and nothing runs', async () => {
    const { d, log } = deps([submit('print(1)')], [run()]);
    const r = await runOperatorTask({ ...d, tasks: { mint: async () => { throw new Error('503 broker'); } } }, 's', 'hi');
    expect(r.status).toBe('OPERATOR_BUSY');
    expect(log.runs).toBe(0);
  });
  it('VSI trouble becomes OPERATOR_BUSY', async () => {
    const d = { llm: { chat: async () => { throw new Error('OPERATOR_BUSY'); } }, tasks: { mint: async () => ({ task_id: 't', capability: 'c' }) }, sandbox: { run: async () => run() } } as never;
    expect((await runOperatorTask(d, 's', 'hi')).status).toBe('OPERATOR_BUSY');
  });
  it('no operator type has a credential-shaped member', () => {
    const text = readFileSync(fileURLToPath(new URL('../src/llm.ts', import.meta.url)), 'utf8');
    expect(text).not.toMatch(/api_?key|secret|password|credential/i);
  });
});

describe('operator loop executor fallback (LIVE FINDING)', () => {
  it('uses the planner model (glm-5.3) as executor from the second attempt when the first answer has no tool call', async () => {
    const roles: string[] = [];
    const { d } = deps([submit('print(1)')], [{ state: 'OK', exit_code: 0, stdout: '1', stderr: '', harness_error: null, attempts: [] } as unknown as SandboxResultLike]);
    const base = d.llm.chat;
    let n = 0;
    d.llm.chat = async (s, role, m, tools, tc, mt) => {
      if (tools) { roles.push(role); if (n++ === 0) return reply({ content: 'Here is the loop: while True: pass' }, 'qwen3.8-27b'); }
      return base(s, role, m, tools, tc, mt);
    };
    const r = await runOperatorTask(d, 's', 'infinite loop');
    expect(roles).toEqual(['executor', 'planner']);
    expect(r.attempts).toBe(2);
  });
});

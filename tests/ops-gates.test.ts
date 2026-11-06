import { describe, expect, it } from 'vitest';
import { GATES, buildEvidence, envProofVerdict, type GateEnv, type Json, type Run } from '../ops/scripts/gates.ts';
import { evidenceDigest } from '../ops/scripts/verify-claims.ts';
import type { Item, OwnerPort } from '../ops/scripts/owner-port.ts';

const SID = 'a1b2c3d4';
const CLEAN = `ENV KEYS: ['HOME', 'LANG', 'PATH']\nENV COUNT: 3\nEXTERNAL CONNECT 1.1.1.1:80 failed: TimeoutError timed out\n`;
const run = (verdicts: Json[] = [], extra: Partial<Run> = {}): Run => ({ verdicts, stages: [], livelist: null, result: null, ...extra });

interface Fake { env: GateEnv; written: { name: string; checks: Record<string, boolean>; data: Json }[]; items: Item[]; removed: string[]; sshLog: string[]; clock: { t: number } }

function fake(over: { onTick?: (f: Fake) => void; attack?: (sid: string, text: string) => Run; http?: GateEnv['http'] } = {}): Fake {
  const clock = { t: 1_000_000 };
  const f: Fake = { written: [], items: [{ kind: 'instance', id: 'p1', label: 'plumbline-prod-db' }, { kind: 'instance', id: 'i1', label: 'plumbline-infra-broker' }, { kind: 'instance', id: 'i2', label: 'plumbline-infra-verifier' }], removed: [], sshLog: [], clock } as unknown as Fake;
  const port: OwnerPort = {
    inventory: async () => [...f.items],
    createInstance: async (s) => { f.items.push({ kind: 'instance', id: `w-${s.label}`, label: s.label }); return { id: `w-${s.label}` }; },
    remove: async (i) => { f.removed.push(i.id); f.items = f.items.filter((x) => x.id !== i.id); },
  };
  f.env = {
    base: 'https://1-2-3-4.sslip.io', http: over.http ?? (async (p) => ({ status: 200, json: p === '/api/session' ? { session_id: SID } : {} })),
    attack: async (sid, text) => over.attack?.(sid, text) ?? run(), owner: async () => port,
    ssh: (cmd) => { f.sshLog.push(cmd); return cmd.includes('is-active') ? 'active\n' : ''; },
    sleep: async (ms) => { clock.t += ms; over.onTick?.(f); }, now: () => clock.t, runUnit: () => true,
    write: (name, checks, data) => { f.written.push({ name, checks, data }); return Object.values(checks).length > 0 && Object.values(checks).every(Boolean); },
  };
  return f;
}

describe('evidence envelope (AG4-OPS-5)', () => {
  const meta = { base: 'https://x.sslip.io', ran_at: '2026-11-07T10:00:00.000Z', git_commit: 'abc', git_dirty: false };
  it('AG4-OPS-5 records base, UTC time, commit and an intact digest', () => {
    const d = buildEvidence('gate-l4', { a: true }, { n: 1 }, meta);
    expect(d).toMatchObject({ gate: 'gate-l4', pass: true, base: meta.base, ran_at: meta.ran_at, git_commit: 'abc' });
    expect(d.evidence_sha256).toBe(evidenceDigest(d));
  });
  it('an empty check set never passes, and one false check fails the gate', () => {
    expect(buildEvidence('g', {}, {}, meta).pass).toBe(false);
    expect(buildEvidence('g', { a: true, b: false }, {}, meta).pass).toBe(false);
  });
  it('editing any field after the run changes the digest', () => {
    const d = buildEvidence('g', { a: true }, {}, meta);
    expect(evidenceDigest({ ...d, ran_at: '2026-11-08T00:00:00.000Z' })).not.toBe(d.evidence_sha256);
  });
});

describe('AG4-OPS-6 sandbox env proof is not vacuous', () => {
  it('AG4-OPS-6 a small, consistent ENV COUNT with no secret names and a blocked connect is clean', () => {
    expect(envProofVerdict(CLEAN)).toMatchObject({ clean: true, count: 3 });
  });
  it('AG4-OPS-6 a VULTR_/PLUMBLINE_ name or token-shaped name makes it unclean', () => {
    expect(envProofVerdict(CLEAN.replace("'PATH'", "'PATH', 'VULTR_KEY_OBSERVER'").replace('COUNT: 3', 'COUNT: 4')).clean).toBe(false);
    expect(envProofVerdict(CLEAN.replace("'PATH'", "'PATH', 'MY_API_TOKEN'").replace('COUNT: 3', 'COUNT: 4')).secret_names).toEqual(['MY_API_TOKEN']);
  });
  it('AG4-OPS-6 the ENV COUNT value matters: zero, huge, missing or disagreeing with the keys list is unclean', () => {
    expect(envProofVerdict(CLEAN.replace('COUNT: 3', 'COUNT: 0')).clean).toBe(false);
    expect(envProofVerdict(CLEAN.replace('COUNT: 3', 'COUNT: 3000')).clean).toBe(false);
    expect(envProofVerdict(CLEAN.replace('COUNT: 3', 'COUNT: 5')).clean).toBe(false);
    expect(envProofVerdict('EXTERNAL CONNECT 1.1.1.1:80 failed: x').clean).toBe(false);
  });
  it('AG4-OPS-6 an external connect that completed is unclean', () => {
    expect(envProofVerdict(CLEAN.replace('1.1.1.1:80 failed: TimeoutError timed out', ': completed (unexpected)')).clean).toBe(false);
  });
  it('AG4-OPS-6 a secret-shaped name anywhere in the output (even outside the keys list) is unclean', () => {
    expect(envProofVerdict(`${CLEAN}leak: PLUMBLINE_TASK_HMAC=abc`).clean).toBe(false);
  });
  it('l1 fails sandbox_env_clean through the gate when the stdout carries a secret name', async () => {
    const http: GateEnv['http'] = async (p, m) => {
      if (p === '/api/session') return { status: 200, json: { session_id: SID } };
      if (p.startsWith('/api/policy/production')) return { status: 403, json: { status: 'SIG_REQUIRED' } };
      if (p.startsWith('/api/policy/')) return { status: 200, json: { text: 'id: protect-tagged-destroy\n    effect: deny' } };
      if (p === '/api/env-proof') return { status: 200, json: { result: { stdout: CLEAN + 'VULTR_API_KEY' } } };
      return { status: m === 'PUT' ? 200 : 200, json: {} };
    };
    const f = fake({ http, attack: () => run([{ rule_id: 'protect-tagged-destroy', decision: 'DENY', model: 'm' }, { rule_id: 'floor-prod-immutable', decision: 'ESCALATE', model: 'm' }]) });
    expect(await GATES.l1!(f.env)).toBe(false);
    expect(f.written[0]?.checks.sandbox_env_clean).toBe(false);
    expect(f.written[0]?.checks.deny_protect_tagged).toBe(true);
  });
});

describe('AG4-OPS-4 gate l3 needs a control run', () => {
  const WK = 'w-plumbline-wk-l3gate';
  const withControl = (s: string) => { process.env.PLUMBLINE_L3_CONTROL_S = s; };
  const killed = (f: Fake) => f.sshLog.some((c) => c.includes('systemctl stop plumbline-broker'));

  it('AG4-OPS-4 passes only for a reaper: worker survives the control window, then dies after the broker is killed', async () => {
    withControl('30');
    const f = fake({ onTick: (x) => { if (killed(x) && x.clock.t % 2 === 0) x.items = x.items.filter((i) => i.id !== WK); } });
    expect(await GATES.l3!(f.env)).toBe(true);
    expect(f.written[0]?.checks).toMatchObject({ control_broker_alive: true, control_worker_survives_while_lease_alive: true, worker_destroyed_after_broker_kill: true });
    expect(f.removed).toEqual([]);
  });
  it('AG4-OPS-4 an always-on sweeper (worker vanishes while the broker is alive) fails the control and the gate', async () => {
    withControl('30');
    const f = fake({ onTick: (x) => { if (x.clock.t > 1_000_000 + 10_000) x.items = x.items.filter((i) => i.id !== WK); } });
    expect(await GATES.l3!(f.env)).toBe(false);
    expect(f.written[0]?.checks.control_worker_survives_while_lease_alive).toBe(false);
    expect(f.written[0]?.checks.worker_destroyed_after_broker_kill).toBe(false);
    expect(killed(f)).toBe(false);
  });
  it('AG4-OPS-4 nothing reaping the worker after the kill fails, and the gate cleans up its own worker', async () => {
    withControl('10');
    const f = fake();
    expect(await GATES.l3!(f.env)).toBe(false);
    expect(f.written[0]?.checks.worker_destroyed_after_broker_kill).toBe(false);
    expect(f.removed).toEqual([WK]);
    expect(f.sshLog.at(-1)).toContain('systemctl start plumbline-broker');
  });
  it('AG4-OPS-4 the gate itself never deletes the worker before it is reaped', async () => {
    withControl('30');
    const f = fake({ onTick: (x) => { if (killed(x)) x.items = x.items.filter((i) => i.id !== WK); } });
    await GATES.l3!(f.env);
    expect(f.removed).toEqual([]);
  });
});

describe('AG4-OPS-6 gate l5 lists Vultr afterwards', () => {
  const verdict = (cls: string, verb: string, ids: string[]): Json => ({ class: cls, verb, decision: 'ALLOW', vultr_ids: ids });
  const good = (_s: string, text: string): Run => {
    // registry: Vultr allows one free registry and plumblinereg holds it, so a create is engine-ALLOWed then refused by Vultr (422); deleting the shared one is DENY floor-registry-shared
    if (text.includes('delete the registry')) return run([{ class: 'registry', verb: 'delete', decision: 'DENY', rule_id: 'floor-registry-shared', vultr_ids: [] }]);
    if (text.includes('registry')) return run([verdict('registry', 'create', [])], { stages: [{ stage: 'run', result: { stdout: 'ERROR PlumblineError: VULTR_ERROR: vultr 422 on /registry' } }] as unknown as Run['stages'] });
    const cls = text.includes('firewall') ? 'firewall_group' : 'vpc';
    return run([verdict(cls, 'create', [`id-${cls}`]), verdict(cls, 'delete', [`id-${cls}`])]);
  };
  it('AG4-OPS-6 passes when create+delete verdicts carry Vultr ids and the owner list no longer shows them', async () => {
    const f = fake({ attack: good });
    expect(await GATES.l5!(f.env)).toBe(true);
    expect(f.written[0]?.checks.vultr_list_confirms_deleted).toBe(true);
  });
  it('AG4-OPS-6 fails when a created resource is still listed at Vultr (decision followed by a failed delete)', async () => {
    const f = fake({ attack: good });
    f.items.push({ kind: 'firewall_group', id: 'id-firewall_group', label: `plumbline-s${SID}-l5fw` });
    expect(await GATES.l5!(f.env)).toBe(false);
    expect(f.written[0]?.checks.vultr_list_confirms_deleted).toBe(false);
  });
  it('AG4-OPS-6 fails when ALLOW verdicts exist but no Vultr id proves a create happened', async () => {
    const f = fake({ attack: (_s, t) => run([verdict(t.includes('firewall') ? 'firewall_group' : 'vpc', 'create', []), verdict('firewall_group', 'delete', [])]) });
    expect(await GATES.l5!(f.env)).toBe(false);
    expect(f.written[0]?.checks.firewall_create_delete).toBe(false);
  });
  it('l5 labels follow the session playground pattern plumbline-s<8hex>-name', async () => {
    const texts: string[] = [];
    const f = fake({ attack: (s, t) => { texts.push(t); return good(s, t); } });
    await GATES.l5!(f.env);
    expect(texts[0]).toMatch(/plumbline-s[0-9a-f]{8}-l5fw/);
  });
});

describe('simple gates', () => {
  it('l4 passes on observer 403 + list 200 and fails on an empty answer', async () => {
    const ok = fake({ http: async (p) => ({ status: 200, json: p === '/api/session' ? { session_id: SID } : [{ status: 403, body: { error: 'Permission denied' } }, { status: 200 }] }) });
    expect(await GATES.l4!(ok.env)).toBe(true);
    expect(await GATES.l4!(fake().env)).toBe(false);
  });
  it('l7 requires the unit test and the deployment flag', async () => {
    const f = fake({ http: async () => ({ status: 200, json: { enabled: false } }) });
    expect(await GATES.l7!(f.env)).toBe(false);
  });
  it('an unknown gate name is not a gate', () => {
    expect(Object.hasOwn(GATES, 'constructor')).toBe(false);
  });
});

describe('GATE-L7 live bond sequence (per-session bond)', () => {
  const SID_B = 'b2b2b2b2';
  const esc = (key: string): Json => ({ decision_id: 'E1', class: 'bucket_object', verb: 'delete', decision: 'ESCALATE', rule_id: 'last-copy-block', quoted_call: { id: key } });
  const denyWorker = (ids: string[] = []): Json => ({ decision_id: 'R1', class: 'instance', verb: 'create', decision: 'DENY', rule_id: 'bond-insufficient', vultr_ids: ids });
  interface Over { escalate?: boolean; approvalStatus?: string; worker?: (sid: string) => Json[]; dollar?: Json[] }

  function l7Fake(o: Over = {}): { f: Fake; posts: string[] } {
    const posts: string[] = [];
    const bonds: Record<string, Json> = {};
    let sessions = 0;
    const bondFor = (sid: string): Json => (bonds[sid] ??= { enabled: true, free: 0.05, held: 0, burned: 0 });
    const http: GateEnv['http'] = async (path, method, body) => {
      if (path === '/api/session') return { status: 200, json: { session_id: sessions++ === 0 ? SID : SID_B } };
      if (path.startsWith('/api/bond')) return { status: 200, json: bondFor(new URL(path, 'http://x').searchParams.get('session_id') ?? '') };
      if (path.startsWith('/api/approvals')) return { status: 200, json: [{ decision_id: 'E1', nonce: 'n1' }] };
      if (path === '/api/approval/E1' && method === 'POST') {
        posts.push(JSON.stringify(body));
        if (o.approvalStatus === undefined || o.approvalStatus === 'DECIDED') bonds[SID] = { enabled: true, free: 0.005, held: 0, burned: 0.045 };
        return { status: 200, json: { status: o.approvalStatus ?? 'DECIDED' } };
      }
      return { status: 404, json: {} };
    };
    const attack = (sid: string, text: string): Run => {
      if (text.includes('vultr.bucket.put')) return run(o.escalate === false ? [] : [esc(/bond-scene\/[\w.-]+/.exec(text)?.[0] ?? '')]);
      if (text.includes('plumbline-wk-bond-probe')) return run((o.worker ?? (() => [denyWorker()]))(sid));
      return run(o.dollar ?? [{ decision_id: 'D1', class: 'instance', verb: 'create', decision: 'DENY', rule_id: 'ceiling-dollar-deny', vultr_ids: [] }]);
    };
    return { f: fake({ http, attack }), posts };
  }
  const checks = (f: Fake): Record<string, boolean> => f.written[0]?.checks ?? {};

  it('passes when the slash is approved, A is refused with no instance and B is untouched, recording the decision ids', async () => {
    const { f, posts } = l7Fake();
    expect(await GATES.l7!(f.env)).toBe(true);
    expect(Object.keys(checks(f)).sort()).toEqual(['bond_enabled_on_deployment', 'live_burned', 'live_next_provision_refused', 'live_other_session_unaffected', 'refuses_after_slash_unit_test']);
    expect(f.written[0]?.data).toMatchObject({ escalate_decision_id: 'E1', refused_decision_id: 'R1', refused_vultr_ids: [], other_session_id: SID_B });
    expect(JSON.parse(posts[0] as string)).toEqual({ session_id: SID, nonce: 'n1', approve: true });
  });
  it('fails live_burned when no ESCALATE was produced, and never posts an approval', async () => {
    const { f, posts } = l7Fake({ escalate: false });
    expect(await GATES.l7!(f.env)).toBe(false);
    expect(checks(f).live_burned).toBe(false);
    expect(posts).toEqual([]);
  });
  it('fails live_burned when the approval is not DECIDED', async () => {
    const { f } = l7Fake({ approvalStatus: 'STALE' });
    expect(await GATES.l7!(f.env)).toBe(false);
    expect(checks(f).live_burned).toBe(false);
  });
  it('fails live_next_provision_refused when the worker is ALLOWed, or the refusal still lists a Vultr id', async () => {
    const allowed = l7Fake({ worker: () => [{ class: 'instance', verb: 'create', decision: 'ALLOW', vultr_ids: ['i-1'] }] });
    await GATES.l7!(allowed.f.env);
    expect(checks(allowed.f).live_next_provision_refused).toBe(false);
    const leaked = l7Fake({ worker: () => [denyWorker(['i-9'])] });
    await GATES.l7!(leaked.f.env);
    expect(checks(leaked.f).live_next_provision_refused).toBe(false);
  });
  it('fails live_other_session_unaffected when the second session is refused for the bond or does not hit the dollar ceiling', async () => {
    const bondHit = l7Fake({ dollar: [denyWorker()] });
    await GATES.l7!(bondHit.f.env);
    expect(checks(bondHit.f).live_other_session_unaffected).toBe(false);
    const silent = l7Fake({ dollar: [] });
    await GATES.l7!(silent.f.env);
    expect(checks(silent.f).live_other_session_unaffected).toBe(false);
  });
  it('with the bond disabled it runs no attack and fails every live check', async () => {
    let fired = 0;
    const f = fake({ http: async () => ({ status: 200, json: { enabled: false } }), attack: () => { fired += 1; return run(); } });
    expect(await GATES.l7!(f.env)).toBe(false);
    expect(fired).toBe(0);
    expect(checks(f)).toMatchObject({ live_burned: false, live_next_provision_refused: false, live_other_session_unaffected: false });
  });
});

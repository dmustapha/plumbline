// L3 lease emitter (G1c). CR-G1b-2: the emitter never asks for more than the verifier's bound; it fails closed without a verifier.
import { describe, expect, it, vi } from 'vitest';
import { LEASE_EMITTER_DEFAULT_TTL_S, LEASE_EMITTER_MAX_TTL_S, LeaseEmitter, clampLeaseTtl, leaseSignature } from '../src/lease.ts';

const SECRET = 'lease-test-secret';
const T = 1_700_000_000_000;

function sentBodies(fetchImpl: ReturnType<typeof vi.fn>): { ts: number; nonce: string; ttl_s: number }[] {
  return (fetchImpl.mock.calls as unknown as [string, { body: string }][]).map((c) => JSON.parse(c[1].body));
}

describe('clampLeaseTtl (AG4-VER-2, CR-G1b-2)', () => {
  it('keeps the recommended 45 s and caps anything above the verifier bound at 60', () => {
    expect(clampLeaseTtl(45)).toBe(45);
    expect(clampLeaseTtl(60)).toBe(60);
    expect(clampLeaseTtl(120)).toBe(LEASE_EMITTER_MAX_TTL_S);
    expect(clampLeaseTtl(3_153_600_000)).toBe(60);
  });
  it('replaces an unusable value with the default and floors fractions', () => {
    for (const bad of [0, -5, NaN, Infinity, 0.4]) expect(clampLeaseTtl(bad)).toBe(LEASE_EMITTER_DEFAULT_TTL_S);
    expect(clampLeaseTtl(20.9)).toBe(20);
  });
});

describe('LeaseEmitter (AG4-VER-2: bounded ttl; AG4-VER-3: no verifier means no renewal)', () => {
  it('signs and sends a bounded ttl even when the config asks for 120 (the verifier would refuse 120 under its 60 bound)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const e = new LeaseEmitter('https://v.example', SECRET, 120, fetchImpl as unknown as typeof fetch, () => T);
    expect(await e.beat()).toBe(true);
    const [b] = sentBodies(fetchImpl);
    expect(b?.ttl_s).toBe(60);
    const init = (fetchImpl.mock.calls as unknown as [string, { headers: Record<string, string> }][])[0]?.[1];
    const sig = init?.headers['x-plumbline-sig'];
    expect(sig).toBe(leaseSignature(SECRET, T, b?.nonce ?? '', 60));
    expect(e.status()).toMatchObject({ configured: true, last_ok_ms: T, ttl_s: 60 });
  });

  it('setTtl is bounded too, and the demo ttl of 20 passes through', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const e = new LeaseEmitter('https://v.example', SECRET, 45, fetchImpl as unknown as typeof fetch, () => T);
    e.setTtl(20);
    await e.beat();
    e.setTtl(9999);
    await e.beat();
    expect(sentBodies(fetchImpl).map((b) => b.ttl_s)).toEqual([20, 60]);
  });

  it('expireNow sends ttl 0 (kill-switch) and restores the bounded ttl afterwards', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const e = new LeaseEmitter('https://v.example', SECRET, 45, fetchImpl as unknown as typeof fetch, () => T);
    expect(await e.expireNow()).toBe(true);
    await e.beat();
    expect(sentBodies(fetchImpl).map((b) => b.ttl_s)).toEqual([0, 45]);
  });

  it('fails closed without a verifier: no request, no renewal, a stated reason', async () => {
    const fetchImpl = vi.fn();
    const e = new LeaseEmitter(null, SECRET, 45, fetchImpl as unknown as typeof fetch, () => T);
    e.start();
    expect(await e.beat()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(e.status()).toMatchObject({ configured: false, last_ok_ms: 0 });
    expect(e.status().last_error).toContain('no verifier');
    e.stop();
  });

  it('an unreachable or refusing verifier never advances last_ok (so the lease lapses and the watchdog acts)', async () => {
    const refuse = vi.fn(async () => new Response('{"ok":false}', { status: 400 }));
    const e = new LeaseEmitter('https://v.example', SECRET, 45, refuse as unknown as typeof fetch, () => T);
    expect(await e.beat()).toBe(false);
    expect(e.status()).toMatchObject({ last_ok_ms: 0, last_error: 'HTTP 400' });
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const e2 = new LeaseEmitter('https://v.example', SECRET, 45, down as unknown as typeof fetch, () => T);
    expect(await e2.beat()).toBe(false);
    expect(e2.status()).toMatchObject({ last_ok_ms: 0, last_error: 'ECONNREFUSED' });
  });
});

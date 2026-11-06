// File: apps/broker/test/tokens.test.ts
import { describe, expect, it } from 'vitest';
import { TokenService } from '../src/tokens.ts';

describe('task tokens', () => {
  it('verifies a fresh token and rejects tampering, expiry and garbage', () => {
    let now = 1000;
    const t = new TokenService('s3cret', () => now);
    const { token } = t.mint('task1', 'sess1', 5000);
    expect(t.verify(token)?.task_id).toBe('task1');
    expect(t.verify(token.slice(0, -2) + 'xx')).toBeNull();
    expect(t.verify('Bearer nope')).toBeNull();
    expect(t.verify(undefined)).toBeNull();
    now += 6000;
    expect(t.verify(token)).toBeNull();
  });
  it('revokeAll invalidates outstanding tokens', () => {
    const t = new TokenService('s3cret');
    const { token } = t.mint('a', 'b');
    t.revokeAll();
    expect(t.verify(token)).toBeNull();
  });
  it('a token minted with another secret is rejected', () => {
    const a = new TokenService('one');
    const b = new TokenService('two');
    expect(b.verify(a.mint('a', 'b').token)).toBeNull();
  });
});

describe('AG4-BRK-8 restart with the kill flag present', () => {
  it('AG4-BRK-8 a token minted before the kill is invalid after a restart while the flag file exists', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { KillSwitch } = await import('../src/killswitch.ts');
    const dir = mkdtempSync(join(tmpdir(), 'plb-kill-'));
    const before = new TokenService('s', () => 1000);
    const token = before.mint('t', 'sess0001').token;
    new KillSwitch(join(dir, 'flag'), before).engage('x');
    const restarted = new TokenService('s', () => 1000);
    expect(restarted.verify(token)).not.toBeNull();
    new KillSwitch(join(dir, 'flag'), restarted);
    expect(restarted.verify(token)).toBeNull();
  });
});

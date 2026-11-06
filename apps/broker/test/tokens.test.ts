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

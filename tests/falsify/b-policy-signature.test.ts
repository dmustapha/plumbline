// FALSIFY (b): a tampered production policy (changed bytes, same signature) is refused; an unsigned production write is SIG_REQUIRED.
// Replace verifyPolicySignature with `() => 'OK'` and these go RED.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../packages/ledger/src/index.ts';
import { policyMessage, verifyPolicySignature } from '../../packages/policy-engine/src/index.ts';
import { PolicyStore } from '../../apps/broker/src/policyStore.ts';
import { assemble } from '../../apps/broker/src/main.ts';
import { baseConfig, secrets } from '../../apps/broker/test/support.ts';
import { createMockVultr } from '../../packages/vultr-adapter/test/support/mock-vultr.ts';
import { makeApi, fakeBroker } from '../../apps/range-api/test/support.ts';

const policyDir = fileURLToPath(new URL('../../policy/', import.meta.url));
const floorText = readFileSync(policyDir + 'floor.yaml', 'utf8');
const defaultText = readFileSync(policyDir + 'session-default.yaml', 'utf8');

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64'), priv: privateKey };
}
const signText = (priv: ReturnType<typeof keys>['priv'], text: string) => sign(null, Buffer.from(policyMessage(text)), priv).toString('base64');
const tamper = (t: string) => t.replace('floor-prod-immutable', 'floor-prod-immutabLe');

describe('FALSIFY (b) production policy signature', () => {
  it('verifier: control OK, one changed byte under the same signature is SIG_INVALID, missing signature is SIG_REQUIRED', () => {
    const k = keys();
    const sig = signText(k.priv, floorText);
    expect(verifyPolicySignature(floorText, sig, k.pub)).toBe('OK');
    expect(verifyPolicySignature(tamper(floorText), sig, k.pub)).toBe('SIG_INVALID');
    expect(verifyPolicySignature(floorText + ' ', sig, k.pub)).toBe('SIG_INVALID');
    expect(verifyPolicySignature(floorText, undefined, k.pub)).toBe('SIG_REQUIRED');
    expect(verifyPolicySignature(floorText, signText(keys().priv, floorText), k.pub)).toBe('SIG_INVALID');
  });
  it('boot: PolicyStore refuses a tampered or unsigned floor when a signature is required, accepts the signed one', () => {
    const k = keys();
    const sig = signText(k.priv, floorText);
    const dir = () => mkdtempSync(join(tmpdir(), 'plb-fals-'));
    expect(() => new PolicyStore(dir(), floorText, sig, k.pub, true, defaultText)).not.toThrow();
    expect(() => new PolicyStore(dir(), tamper(floorText), sig, k.pub, true, defaultText)).toThrow(/BOOT_REFUSED.*SIG_INVALID/);
    expect(() => new PolicyStore(dir(), floorText, undefined, k.pub, true, defaultText)).toThrow(/BOOT_REFUSED.*SIG_REQUIRED/);
  });

  async function brokerWithKey(pub: string) {
    const mock = createMockVultr({});
    const dir = mkdtempSync(join(tmpdir(), 'plb-fals-b-'));
    const cfg = { ...baseConfig, dataDir: dir };
    const policies = new PolicyStore(dir, floorText, undefined, pub, false, defaultText);
    const app = await assemble(cfg, { ...secrets, policyPubkeyB64: pub }, { fetchImpl: mock.fetch, s3: {} as never, db: openDb(':memory:'), policies });
    return app;
  }
  const H = { 'x-plumbline-api-token': secrets.apiToken };

  it('broker route: unsigned is 403 SIG_REQUIRED, tampered-bytes-same-signature is 403 SIG_INVALID, the genuine signed text passes the signature gate', async () => {
    const k = keys();
    const app = await brokerWithKey(k.pub);
    const text = 'version: 9\nrules: []\n';
    const sig = signText(k.priv, text);
    const post = (payload: object) => app.internal.inject({ method: 'POST', url: '/v1/policy-production', headers: H, payload });
    const unsigned = await post({ text });
    expect([unsigned.statusCode, unsigned.json().status]).toEqual([403, 'SIG_REQUIRED']);
    const bad = await post({ text: text.replace('9', '8'), signature: sig });
    expect([bad.statusCode, bad.json().status]).toEqual([403, 'SIG_INVALID']);
    const good = await post({ text, signature: sig });
    expect(good.statusCode).not.toBe(403); // control: the gate really is the signature (genuine signed bytes get past it to DEPLOY_ONLY)
    expect(good.json().status).toBe('DEPLOY_ONLY');
  });

  it('range-api to real broker: every HTTP verb on /api/policy/production without a signature is SIG_REQUIRED; tampered bytes are SIG_INVALID', async () => {
    const k = keys();
    const broker = await brokerWithKey(k.pub);
    const bridge = { call: async (method: string, path: string, body?: unknown) => {
      const r = await broker.internal.inject({ method: method as never, url: path, headers: H, payload: body as never });
      return { status: r.statusCode, json: r.json() };
    } };
    const f = fakeBroker();
    const { app } = await makeApi({ ...f, broker: { ...f.broker, call: bridge.call } } as never);
    const text = 'version: 9\nrules: []\n';
    const sig = signText(k.priv, text);
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE'] as const) {
      const r = await app.inject({ method, url: '/api/policy/production', payload: { policy: text } });
      expect([r.statusCode, r.json().status]).toEqual([403, 'SIG_REQUIRED']);
    }
    const t = await app.inject({ method: 'POST', url: '/api/policy/production', payload: { policy: text + '#x', signature: sig } });
    expect([t.statusCode, t.json().status]).toEqual([403, 'SIG_INVALID']);
  });
});

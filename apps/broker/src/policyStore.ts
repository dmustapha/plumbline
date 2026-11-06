// File: apps/broker/src/policyStore.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { diffRules, parsePolicy, verifyPolicySignature, type PolicyDoc, type PolicyError } from '@plumbline/policy-engine';

export interface SessionPolicy {
  text: string;
  doc: PolicyDoc;
  touched: number;
}

const SID = /^[a-z0-9]{8,32}$/;

export class PolicyStore {
  readonly floor: PolicyDoc;
  readonly defaultText: string;
  readonly defaultDoc: PolicyDoc;
  readonly systemDoc: PolicyDoc;
  readonly #copies = new Map<string, SessionPolicy>();

  constructor(
    private readonly dir: string,
    floorText: string,
    floorSig: string | undefined,
    pubkeyB64: string,
    requireSig: boolean,
    defaultText: string,
    private readonly clock: () => number = Date.now,
  ) {
    if (requireSig) {
      const status = verifyPolicySignature(floorText, floorSig, pubkeyB64);
      if (status !== 'OK') throw new Error(`BOOT_REFUSED: production floor signature ${status}`);
    }
    const f = parsePolicy(floorText, 'floor');
    if (!f.ok) throw new Error(`BOOT_REFUSED: floor invalid ${JSON.stringify(f.errors)}`);
    const d = parsePolicy(defaultText, 'session');
    if (!d.ok) throw new Error(`BOOT_REFUSED: session default invalid ${JSON.stringify(d.errors)}`);
    this.floor = f.policy;
    this.defaultText = defaultText;
    this.defaultDoc = d.policy;
    this.systemDoc = { ...d.policy, rules: d.policy.rules.filter((r) => r.id !== 'protect-tagged-destroy') };
    mkdirSync(join(dir, 'sessions'), { recursive: true });
  }

  static fromFiles(dir: string, floorPath: string, sigPath: string, defaultPath: string, pubkey: string, requireSig: boolean): PolicyStore {
    const sig = existsSync(sigPath) ? readFileSync(sigPath, 'utf8').trim() : undefined;
    return new PolicyStore(dir, readFileSync(floorPath, 'utf8'), sig, pubkey, requireSig, readFileSync(defaultPath, 'utf8'));
  }

  get(sid: string): SessionPolicy {
    const have = this.#copies.get(sid);
    if (have) {
      have.touched = this.clock();
      return have;
    }
    const fresh: SessionPolicy = { text: this.defaultText, doc: this.defaultDoc, touched: this.clock() };
    this.#copies.set(sid, fresh);
    return fresh;
  }

  put(sid: string, text: string): { ok: true; version: number; hash: string; diff: string[] } | { ok: false; errors: PolicyError[] } {
    if (!SID.test(sid)) return { ok: false, errors: [{ line: null, message: 'bad session id' }] };
    const parsed = parsePolicy(text, 'session');
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    const copy: SessionPolicy = { text, doc: parsed.policy, touched: this.clock() };
    this.#copies.set(sid, copy);
    writeFileSync(join(this.dir, 'sessions', `${sid}.yaml`), text);
    return { ok: true, version: parsed.policy.version, hash: parsed.policy.hash, diff: diffRules(this.defaultDoc, parsed.policy) };
  }

  reset(sid: string): void {
    this.#copies.delete(sid);
  }

  sweep(idleMs: number): string[] {
    const gone: string[] = [];
    for (const [sid, c] of this.#copies) {
      if (this.clock() - c.touched > idleMs) {
        this.#copies.delete(sid);
        gone.push(sid);
      }
    }
    return gone;
  }
}

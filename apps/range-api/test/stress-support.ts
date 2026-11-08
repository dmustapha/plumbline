// Helpers for stress-api.test.ts: a seeded PRNG, a stateful scripted broker and JSON fuzz generators. Hermetic: no sockets, no network.
import { fakeBroker } from './support.ts';

/** mulberry32: tiny deterministic PRNG. The fuzz suite always seeds it with 1337 so a failure reproduces byte for byte. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_POLICY = 'DEFAULT-POLICY';

/**
 * fakeBroker plus per-session state: PUT/GET /v1/policy/<sid> store and return the text (default for a session never written),
 * POST /v1/session/<sid>/tier stores the tier. `jitter` yields to the event loop a random number of times so parallel
 * requests interleave. `chatGate` (when set) holds every operator LLM call until released, which keeps an attack in flight.
 */
export function statefulBroker(rng: () => number = mulberry32(7)) {
  const f = fakeBroker();
  const base = f.broker.call;
  const policy = new Map<string, string>();
  const tier = new Map<string, string>();
  const state = { policyWrites: 0, chatCalls: 0, chatGate: null as Promise<void> | null };
  const jitter = async (): Promise<void> => { for (let i = Math.floor(rng() * 5); i > 0; i--) await new Promise((r) => setImmediate(r)); };
  f.broker.call = (async (method: string, path: string, body?: unknown) => {
    const pol = /^\/v1\/policy\/([^/?]+)$/.exec(path);
    if (pol) {
      f.calls.push({ method, path, body });
      const sid = decodeURIComponent(pol[1] as string);
      await jitter();
      if (method === 'PUT') { policy.set(sid, (body as { text: string }).text); state.policyWrites += 1; return { status: 200, json: { status: 'OK' } }; }
      return { status: 200, json: { text: policy.get(sid) ?? DEFAULT_POLICY } };
    }
    const t = /^\/v1\/session\/([^/?]+)\/tier$/.exec(path);
    if (t) {
      f.calls.push({ method, path, body });
      tier.set(decodeURIComponent(t[1] as string), (body as { tier: string }).tier);
      return { status: 200, json: { status: 'OK', tier: (body as { tier: string }).tier } };
    }
    return base(method, path, body);
  }) as never;
  (f.broker as { chat: unknown }).chat = async () => {
    state.chatCalls += 1;
    if (state.chatGate) await state.chatGate;
    throw new Error('OPERATOR_BUSY');
  };
  return { ...f, policy, tier, ext: state };
}

// ---- JSON fuzz generators (emit raw JSON text so that keys such as __proto__ stay own keys) ----

export const STRING_POOL = [
  '', ' ', 'a', 'abc', 'a'.repeat(255), 'a'.repeat(300), 'a'.repeat(301), '🔥💀🎯', '<script>alert(1)</script>', "'; DROP TABLE--", 'NULL', 'undefined', 'null', 'true',
  '\u0000\u0000\u0000', 'a\u0000b', '‮evil‬', '​', '../../etc/passwd', '..%2f..%2fetc%2fpasswd', '%00', '\ud800', '__proto__', 'constructor', 'prototype',
  'observer', 'standard', 'delete', 'restore', 'system', 'production', '00001000', 'deadbeef', '${jndi:ldap://x}', '{{7*7}}', '\r\nX-Injected: 1', '\u0000'.repeat(40),
];

const NUM_POOL = ['0', '-0', '-1', '1', '0.0001', '9007199254740991', '-9007199254740991', '1e308', '-1e308', '5e-324', '1e999', '-1e999', '123456789012345678901234567890', '0.1e-5'];
const KEY_POOL = ['text', 'session_id', 'nonce', 'approve', 'tier', 'action', 'policy', 'signature', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '', ' ', 'a', '🔥'];

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;

function randString(rng: () => number): string {
  if (rng() < 0.6) return pick(rng, STRING_POOL);
  const n = Math.floor(rng() * 40);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(Math.floor(rng() * (rng() < 0.2 ? 0xffff : 0x7f)));
  return s;
}

/** A random JSON value as raw text. depth caps nesting; keys may be the prototype-pollution names. */
export function randJson(rng: () => number, depth = 0): string {
  const kinds = depth > 4 ? 6 : 9;
  switch (Math.floor(rng() * kinds)) {
    case 0: return 'null';
    case 1: return rng() < 0.5 ? 'true' : 'false';
    case 2: case 3: return pick(rng, NUM_POOL);
    case 4: case 5: return JSON.stringify(randString(rng));
    case 6: return `[${Array.from({ length: Math.floor(rng() * 5) }, () => randJson(rng, depth + 1)).join(',')}]`;
    default: return `{${Array.from({ length: Math.floor(rng() * 6) }, () => `${JSON.stringify(pick(rng, KEY_POOL))}:${randJson(rng, depth + 1)}`).join(',')}}`;
  }
}

/** An object that carries the route's real field names with random values: reaches past the first validation layer. */
export function randShaped(rng: () => number, fields: readonly string[]): string {
  const chosen = fields.filter(() => rng() < 0.8);
  const extra = rng() < 0.3 ? [pick(rng, ['__proto__', 'constructor', 'prototype'])] : [];
  const body = [...chosen, ...extra].map((k) => {
    if (k === '__proto__') return `"__proto__":{"polluted":"yes"}`;
    if (k === 'constructor') return `"constructor":{"prototype":{"polluted":"yes"}}`;
    if (k === 'prototype') return `"prototype":{"polluted":"yes"}`;
    return `${JSON.stringify(k)}:${rng() < 0.5 ? randJson(rng, 3) : JSON.stringify(pick(rng, STRING_POOL))}`;
  });
  return `{${body.join(',')}}`;
}

/** Valid-ish value per field so some fuzz bodies are accepted all the way through the handler. */
export function validish(field: string): string {
  switch (field) {
    case 'text': return '"list my instances"';
    case 'tier': return '"observer"';
    case 'action': return '"restore"';
    case 'approve': return 'true';
    case 'nonce': return '"abc"';
    default: return '"x"';
  }
}

// File: apps/broker/src/egress.ts
// The agent's only outbound path. It runs inside the credential-holding broker, so the SSRF guard lives HERE in code
// and does not depend on the engine's host rule (AG4-BRK-4): no IP literals, no private/link-local/metadata targets,
// the resolved address is pinned for the connection, redirects are never followed, and the body is capped while streaming.
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const VIRTUAL_HOST = 'range.plumbline.local';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const OK_PORTS = new Set(['', '80', '443']);

export class EgressRefused extends Error {
  readonly code = 'EGRESS_REFUSED';
  constructor(reason: string) {
    super(reason);
    this.name = 'EgressRefused';
  }
}

export interface TransportRequest {
  url: URL;
  ip: string;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (host: string) => Promise<string[]>;

export interface EgressResult {
  status: number;
  host: string;
  text: string;
  truncated: boolean;
  redirect_to?: string;
}

function v4Bytes(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) ? b : null;
}

function v4Public(b: number[]): boolean {
  const [a, c] = [b[0] as number, b[1] as number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && c >= 64 && c <= 127) return false;
  if (a === 169 && c === 254) return false;
  if (a === 172 && c >= 16 && c <= 31) return false;
  if (a === 192 && (c === 168 || (c === 0 && b[2] === 0))) return false;
  if (a === 198 && (c === 18 || c === 19)) return false;
  return true;
}

function v6Words(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const b = v4Bytes(tail[1] as string);
    if (!b) return null;
    s = s.slice(0, tail.index) + ((b[0] as number) * 256 + (b[1] as number)).toString(16) + ':' + ((b[2] as number) * 256 + (b[3] as number)).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...Array<string>(fill).fill('0'), ...rest].map((w) => Number.parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** True only for a globally routable unicast address. Anything unparseable is treated as NOT public (fail closed). */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Public(v4Bytes(ip) as number[]);
  if (kind !== 6) return false;
  const w = v6Words(ip);
  if (!w) return false;
  const first = w[0] as number;
  if (w.every((x) => x === 0) || (w.slice(0, 7).every((x) => x === 0) && w[7] === 1)) return false;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return v4Public([(w[6] as number) >> 8, (w[6] as number) & 255, (w[7] as number) >> 8, (w[7] as number) & 255]);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return false;
  if (first === 0x64 && w[1] === 0xff9b) return false;
  if (first === 0x2001 && w[1] === 0x0db8) return false;
  if (first === 0x2002) return false;
  return (first & 0xe000) === 0x2000;
}

const defaultResolve: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const defaultTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const secure = req.url.protocol === 'https:';
    const r = (secure ? httpsRequest : httpRequest)({
      host: req.ip, port: req.url.port || (secure ? 443 : 80), path: `${req.url.pathname}${req.url.search}`, method: 'GET',
      headers: { host: req.url.host, 'user-agent': 'plumbline-broker/1', accept: '*/*' }, servername: req.url.hostname, signal: req.signal,
    }, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      resolve({ status: res.statusCode ?? 0, headers, body: res });
    });
    r.on('error', reject);
    r.end();
  });

export class Egress {
  readonly #resolve: Resolver;
  readonly #transport: Transport;

  constructor(
    private readonly rangeApiUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    hooks: { resolve?: Resolver; transport?: Transport } = {},
  ) {
    this.#resolve = hooks.resolve ?? defaultResolve;
    this.#transport = hooks.transport ?? defaultTransport;
  }

  async fetch(url: string): Promise<EgressResult> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new EgressRefused('not a valid URL');
    }
    if (u.hostname === VIRTUAL_HOST) return this.#rangePage(u);
    const ip = await this.#vet(u);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await this.#transport({ url: u, ip, signal });
    const { text, truncated } = await readCapped(res.body);
    const location = res.headers.location;
    const base: EgressResult = { status: res.status, host: u.hostname, text, truncated };
    return res.status >= 300 && res.status < 400 && location ? { ...base, redirect_to: location } : base;
  }

  async #vet(u: URL): Promise<string> {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EgressRefused('only http and https are allowed');
    if (u.username || u.password) throw new EgressRefused('credentials in the URL are not allowed');
    if (!OK_PORTS.has(u.port)) throw new EgressRefused('only the default http/https ports are allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0) throw new EgressRefused('IP literals are not allowed; use a hostname');
    let addrs: string[];
    try {
      addrs = await this.#resolve(host);
    } catch {
      throw new EgressRefused('host does not resolve');
    }
    if (addrs.length === 0) throw new EgressRefused('host does not resolve');
    if (!addrs.every(isPublicIp)) throw new EgressRefused('host resolves to a non-public address');
    return addrs[0] as string;
  }

  async #rangePage(u: URL): Promise<EgressResult> {
    if (!u.pathname.startsWith('/pages/')) return { status: 404, host: u.hostname, text: 'only /pages/* is served', truncated: false };
    const res = await this.fetchImpl(this.rangeApiUrl + u.pathname, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const { text, truncated } = await readCapped(res.body ? (res.body as unknown as AsyncIterable<Uint8Array>) : (async function* () { /* empty */ })());
    return { status: res.status, host: u.hostname, text, truncated };
  }

  readCounter(): Promise<{ dropped_packets: number | null; source: string }> {
    return new Promise((resolve) => {
      execFile('sudo', ['-n', '/usr/local/sbin/plb-egress-counter'], { timeout: 3000 }, (err, stdout) => {
        const n = Number.parseInt(String(stdout).trim(), 10);
        if (err || Number.isNaN(n)) resolve({ dropped_packets: null, source: 'unavailable' });
        else resolve({ dropped_packets: n, source: 'iptables DOCKER-USER drop counter' });
      });
    });
  }
}

/** Reads at most MAX_BYTES (plus one byte to detect overflow) and stops pulling from the stream as soon as that is reached. */
async function readCapped(body: AsyncIterable<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  const parts: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    if (size + buf.length > MAX_BYTES) {
      parts.push(buf.subarray(0, MAX_BYTES - size));
      size = MAX_BYTES;
      truncated = true;
      break;
    }
    parts.push(buf);
    size += buf.length;
  }
  return { text: Buffer.concat(parts).toString('utf8'), truncated };
}

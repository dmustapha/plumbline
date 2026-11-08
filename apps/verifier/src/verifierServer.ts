// File: apps/verifier/src/verifierServer.ts
// PRD C9 interface: `GET /api/verify` (public, cached, never calls Vultr), `POST /api/verify/run` (one run per 5 s), `POST /lease/renew`
// (HMAC-signed). run() takes the live list TWICE with a gap (3 s), THEN the signed ledger export (AG4-PRD-7), reads the baseline
// manifest and the watchdog's destroy log, and reconciles. See apps/verifier/docs/F5.md.
import { createHmac } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { VultrHttp } from '@plumbline/vultr-adapter';
import type { VerifierConfig } from './config.ts';
import { LeaseReceiver, leaseState, readLease } from './lease.ts';
import { reconcile, type LedgerExport, type Report } from './reconcile.ts';
import { loadBaseline, readDestroyed, readPin, writePin, type FloorLoad } from './sharedFiles.ts';
import { snapshot } from './vultr-lite.ts';

export { loadBaseline } from './sharedFiles.ts';

export interface VerifierDeps {
  config: VerifierConfig;
  http: VultrHttp;
  floor: FloorLoad;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  host?: string;
}

/** A GREEN report older than this is served as STALE. */
export const STALE_GREEN_MS = 300_000;
const RUN_GAP_MS = 5000;
const LEDGER_SCHEMA = 'plumbline-ledger-export/v2';

export async function fetchLedger(d: VerifierDeps, clock: () => number): Promise<{ ledger: LedgerExport | null; error?: string }> {
  const ts = clock();
  const sig = createHmac('sha256', d.config.leaseSecret).update(`export.${ts}`).digest('hex');
  try {
    const url = `${d.config.brokerPublicUrl}${d.config.ledgerExportPath}`;
    const res = await (d.fetchImpl ?? fetch)(url, { headers: { 'x-plumbline-ts': String(ts), 'x-plumbline-sig': sig }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ledger: null, error: `HTTP ${res.status}` };
    const body = (await res.json()) as LedgerExport;
    return body?.schema === LEDGER_SCHEMA ? { ledger: body } : { ledger: null, error: `unexpected schema ${String((body as { schema?: unknown })?.schema)}` };
  } catch (e) {
    return { ledger: null, error: String((e as Error).message).slice(0, 100) };
  }
}

function writeShared(dir: string, name: string, body: unknown): void {
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o640 });
  chmodSync(tmp, 0o640);
  renameSync(tmp, join(dir, name));
}

const NO_RUN: Partial<Report> & { detail: string } = {
  status: 'DEGRADED', codes: ['RECONCILE_DEGRADED'], findings: [], counts: undefined, polls: [], detail: 'no run yet; press Run verify',
};

export function buildVerifier(d: VerifierDeps) {
  const clock = d.clock ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const host = d.host ?? hostname();
  const startedAt = clock();
  const receiver = new LeaseReceiver(d.config.leaseSecret, d.config.sharedDir, clock, d.config.leaseMaxTtlS);
  let last: Report | null = null;
  let lastRunAt = 0;
  let running: Promise<Report> | null = null;
  let leaseSeen = false;

  async function execute(): Promise<Report> {
    const poll1 = await snapshot(d.http, clock);
    await sleep(d.config.pollGapMs);
    const poll2 = await snapshot(d.http, clock);
    const { ledger, error } = await fetchLedger(d, clock);
    const log = readDestroyed(d.config.sharedDir, d.config.watchdogUid);
    const notes = [...(log.rejected ? [log.rejected] : []), ...(d.floor.note ? [d.floor.note] : [])];
    const report = reconcile({
      poll1, poll2, ledger, ledgerError: error, baseline: loadBaseline(d.config.baselinePath), watchdogDestroyed: log.entries, floor: d.floor.floor,
      now: clock(), ledgerTrust: 'fetched', maxExportAgeMs: d.config.exportMaxAgeMs, continuity: readPin(d.config.stateDir), host, notes,
    });
    if (report.ledger.pin) writePinQuietly(report.ledger.pin);
    last = report;
    writeShared(d.config.sharedDir, 'last-verify.json', report);
    return report;
  }

  function writePinQuietly(pin: NonNullable<Report['ledger']['pin']>): void {
    try { writePin(d.config.stateDir, pin); } catch { /* the in-process report still stands; the pin is rebuilt next run */ }
  }

  function run(): Promise<Report> {
    if (running) return running;
    lastRunAt = clock();
    running = execute().finally(() => { running = null; });
    return running;
  }

  const app = Fastify({ logger: false, bodyLimit: 4096 });
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) void reply.header('access-control-allow-origin', '*');
  });
  app.get('/healthz', async () => {
    const l = readLease(d.config.sharedDir);
    const state = leaseState(l, clock(), { startedAt, everSeen: leaseSeen });
    if (state === 'ALIVE') leaseSeen = true;
    return { ok: true, lease: state };
  });
  // STRESS DH-8: a cached GREEN may not be served as GREEN forever. Past STALE_GREEN_MS it reads STALE (last_status keeps what it was), so a judge
  // who curls this endpoint hours later cannot take an old all-clear for the present. A RED never decays into silence: it stays RED, marked stale.
  const view = (r: Report): Record<string, unknown> => {
    const age = Math.max(0, clock() - r.generated_at);
    const base = { ...r, age_s: Math.round(age / 1000) };
    return r.status === 'GREEN' && age > STALE_GREEN_MS ? { ...base, status: 'STALE', last_status: 'GREEN', stale: true } : age > STALE_GREEN_MS ? { ...base, stale: true } : base;
  };
  app.get('/api/verify', async () => (last ? view(last) : NO_RUN));
  app.post('/api/verify/run', async (_req, reply) => {
    if (running) return reply.code(409).send({ status: 'RUNNING' });
    if (clock() - lastRunAt < RUN_GAP_MS && last) return reply.code(429).header('retry-after', '5').send({ status: 'RATE_LIMITED' });
    return run();
  });
  app.post<{ Body: { ts: number; nonce: string; ttl_s: number } }>('/lease/renew', async (req, reply) => {
    const r = receiver.accept(req.body, String(req.headers['x-plumbline-sig'] ?? ''));
    if (r.ok) return { ok: true };
    return reply.code(r.why === 'malformed' || r.why === 'ttl-too-large' ? 400 : 401).send({ ok: false, why: r.why });
  });
  app.get('/api/watchdog', async () => {
    try { return JSON.parse(readFileSync(join(d.config.sharedDir, 'watchdog-status.json'), 'utf8')); } catch { return { status: 'UNKNOWN' }; }
  });
  return { app, run };
}

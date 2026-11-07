// File: apps/verifier/src/watchdog.ts
// L3 dead hand (PRD C9, F7). Runs on VM 2 as its OWN Unix user with its own `provisioning` + `firewall` key (D-R6a). It reads the lease the
// verifier writes and, when the lease has lapsed, deletes ONLY dead-hand-scoped resources:
//   instances labelled `plumbline-wk-*`, and playground VPCs / firewall groups whose label matches PLAYGROUND_LABEL_RE exactly.
// Defence in depth for DT-21 (wrong-resource delete): (1) the strict scope filter below, (2) the engine decides every delete under the
// signed repository floor (floor-prod-immutable, scope-label-prefix, playground-label-malformed), (3) baseline ids are never touched,
// (4) the adapter refuses a delete without a genuine AllowDecision bound to the exact request. The lease reader fails CLOSED (AG4-VER-3).
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, accessSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLAYGROUND_LABEL_RE, evaluate, parsePolicy,
  type CallRequest, type Decision, type EngineState, type PolicyDoc, type ResourceClass,
} from '@plumbline/policy-engine';
import { Firewalls, Instances, OutcomeUnknown, TIER_ACL, VultrError, Vpcs, type VultrHttp } from '@plumbline/vultr-adapter';
import { probeAclBehaviour } from './vultr-lite.ts';
import { DEFAULT_LEASE_MAX_TTL_S, DEFAULT_GRACE_MS, leaseState, readLease, type LeaseState } from './lease.ts';

export const WORKER_PREFIX = 'plumbline-wk-';
export const ACTIONS_FILE = 'watchdog-actions.jsonl';
export const STATUS_FILE = 'watchdog-status.json';

/** The session layer of the watchdog's engine call. The floor (repository, signed) still wins every conflict. */
export const WATCHDOG_POLICY = `version: 1
rules:
  - id: protect-tagged-destroy
    effect: deny
    priority: 90
    match: { verb: [delete], class: [instance, firewall_group, vpc], tags_any: [protected] }
    reason: "protected resources cannot be destroyed, even by the dead hand"
  - id: allow-worker-delete
    effect: allow
    priority: 10
    match: { verb: [delete], class: [instance], label_prefix: [plumbline-wk-] }
    reason: "dead hand: expired lease, destroy workers"
  - id: allow-breadth-delete
    effect: allow
    priority: 10
    match: { verb: [delete], class: [firewall_group, vpc], label_prefix: [plumbline-s] }
    reason: "dead hand: expired lease, destroy session playgrounds"
`;

export function watchdogPolicy(): PolicyDoc {
  const r = parsePolicy(WATCHDOG_POLICY, 'session');
  if (!r.ok) throw new Error('watchdog policy invalid');
  return r.policy;
}

const STATE: EngineState = {
  now_ms: 0, rate_card: null, session_spent_usd: 0, session_ceiling_usd: 0, global_spent_usd: 0, global_cap_usd: 0, live_worker_count: 0, max_instances: 0,
  kill_switch: false, session_tier: 'standard', tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
  object_versions: null, restorable: null, bond: { enabled: false, free_usd: 0 },
};

/** What the dead hand may delete at all (AG4-VER-5: the strict playground regex, never the bare `plumbline-s` prefix). */
export function inDeadHandScope(cls: ResourceClass, label: string): boolean {
  if (cls === 'instance') return label.startsWith(WORKER_PREFIX) && label.length > WORKER_PREFIX.length;
  if (cls === 'firewall_group' || cls === 'vpc') return PLAYGROUND_LABEL_RE.test(label);
  return false;
}

export interface Target {
  id: string;
  label: string;
  tags: string[];
  cls: ResourceClass;
}

/** One engine decision for one delete; `seq` keeps every request id unique because the adapter burns an ALLOW per request id. */
export function decideDelete(t: Target, policy: PolicyDoc, floor: PolicyDoc, now: number, seq: number | string): { req: CallRequest; decision: Decision } {
  const req: CallRequest = {
    request_id: `wd-${t.id}-${now}-${seq}`, task_id: 'watchdog', session_id: 'watchdog', verb: 'delete', class: t.cls,
    target: { id: t.id, label: t.label, tags: t.tags, resolved: true }, params: {}, caller: 'sandbox',
  };
  return { req, decision: evaluate(req, policy, floor, { ...STATE, now_ms: now }) };
}

/** Dry-run unless the operator explicitly wrote `PLUMBLINE_WATCHDOG_DRY_RUN=0`: an unset or mistyped value never goes live (DT-21). */
export function resolveDryRun(env: Record<string, string | undefined>): boolean {
  return env.PLUMBLINE_WATCHDOG_DRY_RUN !== '0';
}

/** The watchdog must not run as root or as the verifier user (which owns lease.json). */
export function assertOwnUser(myUid: number, verifierUid: number | null): void {
  if (verifierUid === null) throw new Error('BOOT_REFUSED: PLUMBLINE_VERIFIER_UID is required (lease.json must be owned by the verifier user)');
  if (myUid === 0) throw new Error('BOOT_REFUSED: the watchdog must not run as root');
  if (myUid === verifierUid) throw new Error('BOOT_REFUSED: the watchdog must run as its own user, not the verifier user');
}

/** AG4-VER-7: the watchdog key carries exactly `provisioning` + `firewall`. Anything else, or a failed read, refuses the boot (fail closed). */
export const WATCHDOG_ACLS: readonly string[] = [TIER_ACL.deployer, TIER_ACL.network];

export async function assertWatchdogKey(http: VultrHttp): Promise<string[]> {
  let acls: string[];
  try {
    const res = await http.request<{ account?: { acls?: unknown } }>('GET', '/account', { session_id: 'watchdog' });
    const raw = res?.account?.acls;
    if (!Array.isArray(raw)) throw new Error('response carries no acls array');
    acls = raw.map(String);
  } catch (e) {
    if (e instanceof VultrError && e.status === 403) {
      await probeAclBehaviour(http, { session_id: 'watchdog' }, 'watchdog', ['/instances', '/firewalls'], ['/account', '/users', '/object-storage', '/billing/pending-charges']);
      return [...WATCHDOG_ACLS];
    }
    throw new Error(`BOOT_REFUSED: cannot read the watchdog key's ACLs (fail closed): ${String((e as Error).message).slice(0, 100)}`);
  }
  const extra = acls.filter((a) => !WATCHDOG_ACLS.includes(a));
  if (extra.length > 0) throw new Error(`BOOT_REFUSED: the watchdog key is over-scoped, extra ACLs: ${extra.join(',')}`);
  const missing = WATCHDOG_ACLS.filter((a) => !acls.includes(a));
  if (missing.length > 0) throw new Error(`BOOT_REFUSED: the watchdog key lacks ${missing.join(',')}`);
  return acls;
}

/** Why a null lease is null, for the status file (a deployment mistake must be visible, not look like a dead broker). */
export function diagnoseLease(dir: string, verifierUid: number | null): string {
  const file = join(dir, 'lease.json');
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return 'rejected: not a regular file (symlink?)';
    if ((st.mode & 0o022) !== 0) return 'rejected: writable by group or others';
    if (verifierUid !== null && st.uid !== verifierUid) return `rejected: owned by uid ${st.uid}, expected the verifier uid ${verifierUid}`;
    accessSync(file, constants.R_OK);
    return 'rejected: unparseable, mistyped or over the ttl bound';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : `unreadable: ${(e as NodeJS.ErrnoException).code ?? 'error'}`;
  }
}

/** Append-only destroy log. Owned by the watchdog uid, mode 0644 (the verifier reads it as another user), never a symlink (F5 section 4, AG4-VER-4). */
export class ActionsLog {
  readonly #path: string;
  constructor(dir: string, private readonly clock: () => number) {
    this.#path = join(dir, ACTIONS_FILE);
    this.append({ act: 'boot' });
  }

  append(entry: Record<string, unknown>): void {
    const fd = openSync(this.#path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error('actions log is not a regular file');
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`actions log is owned by uid ${st.uid}, not the watchdog`);
      if ((st.mode & 0o777) !== 0o644) fchmodSync(fd, 0o644);
      writeSync(fd, JSON.stringify({ ts: this.clock(), ...entry }) + '\n');
    } finally {
      closeSync(fd);
    }
  }
}

export interface WatchdogDeps {
  http: VultrHttp;
  floor: PolicyDoc;
  sharedDir: string;
  dryRun: boolean;
  verifierUid: number | null;
  /** first-contact grace before a missing lease counts as lapsed (AG4-VER-3) */
  leaseGraceMs?: number;
  /** M1: a stale (not only a missing) lease.json is excused during the start-up grace window. Production wiring sets it; default off. */
  bootGrace?: boolean;
  /** ids of the baseline manifest: never deleted, whatever their label says. null = the manifest could not be read */
  baselineIds?: () => ReadonlySet<string> | null;
  clock?: () => number;
}

export interface SweepResult {
  considered: number;
  would_delete: { id: string; label: string; class: string }[];
  destroyed: string[];
  refused: { id: string; rule_id: string }[];
  protected_skipped: string[];
  errors: string[];
}

export type TickStatus = 'ALIVE' | 'NEVER' | 'DESTROYING' | 'DONE' | 'DEGRADED';

const emptySweep = (): SweepResult => ({ considered: 0, would_delete: [], destroyed: [], refused: [], protected_skipped: [], errors: [] });
const CTX = { session_id: 'watchdog' };

export class Watchdog {
  readonly #policy = watchdogPolicy();
  readonly #log: ActionsLog;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #refusedLogged = new Set<string>();
  /** deletes whose outcome we never saw: confirmed (logged destroyed) once the id is gone from a successful listing */
  readonly #unconfirmed = new Map<string, Target>();
  #everSeen = false;
  #seq = 0;
  readonly #run = randomBytes(4).toString('hex');

  constructor(private readonly d: WatchdogDeps) {
    this.#now = d.clock ?? Date.now;
    this.#startedAt = this.#now();
    this.#log = new ActionsLog(d.sharedDir, this.#now);
  }

  async #list(res: SweepResult): Promise<{ targets: Target[]; complete: boolean }> {
    const targets: Target[] = [];
    let complete = true;
    const attempt = async (what: string, run: () => Promise<void>): Promise<void> => {
      try { await run(); } catch (e) { complete = false; res.errors.push(`list ${what}: ${String((e as Error).message).slice(0, 120)}`); }
    };
    const tag = (d: string): string[] => (d.includes('[protected]') ? ['protected'] : []);
    await attempt('instances', async () => { for (const i of await new Instances(this.d.http).list(CTX)) targets.push({ id: i.id, label: i.label, tags: i.tags, cls: 'instance' }); });
    await attempt('vpcs', async () => { for (const v of await new Vpcs(this.d.http).list(CTX)) targets.push({ id: v.id, label: v.description, tags: tag(v.description), cls: 'vpc' }); });
    await attempt('firewalls', async () => { for (const f of await new Firewalls(this.d.http).list(CTX)) targets.push({ id: f.id, label: f.description, tags: tag(f.description), cls: 'firewall_group' }); });
    return { targets, complete };
  }

  #confirmUnknown(listed: Set<string>, complete: boolean, res: SweepResult): void {
    if (!complete) return;
    for (const [id, t] of this.#unconfirmed) {
      if (listed.has(id)) continue;
      this.#unconfirmed.delete(id);
      res.destroyed.push(id);
      this.#log.append({ act: 'destroyed', id, class: t.cls, label: t.label, confirmed_by: 'absent-from-listing' });
    }
  }

  async #destroy(t: Target, decision: Decision, req: CallRequest, res: SweepResult): Promise<void> {
    if (decision.decision !== 'ALLOW') return;
    try {
      if (t.cls === 'instance') await new Instances(this.d.http).delete(decision, req);
      else if (t.cls === 'vpc') await new Vpcs(this.d.http).delete(decision, req);
      else await new Firewalls(this.d.http).delete(decision, req);
    } catch (e) {
      if (e instanceof OutcomeUnknown) this.#unconfirmed.set(t.id, t);
      res.errors.push(`delete ${t.id}: ${String((e as Error).message).slice(0, 120)}`);
      return;
    }
    res.destroyed.push(t.id);
    try {
      this.#log.append({ act: 'destroyed', id: t.id, class: t.cls, label: t.label });
    } catch (e) {
      res.errors.push(`log ${t.id}: ${String((e as Error).message).slice(0, 120)}`);
    }
  }

  async #handle(t: Target, res: SweepResult): Promise<void> {
    res.considered += 1;
    const now = this.#now();
    this.#seq += 1;
    const { req, decision } = decideDelete(t, this.#policy, this.d.floor, now, `${this.#run}-${this.#seq}`);
    if (decision.decision !== 'ALLOW') {
      res.refused.push({ id: t.id, rule_id: decision.rule_id });
      if (!this.#refusedLogged.has(t.id)) { this.#refusedLogged.add(t.id); this.#log.append({ act: 'refused', id: t.id, label: t.label, class: t.cls, rule_id: decision.rule_id }); }
    } else if (this.d.dryRun) res.would_delete.push({ id: t.id, label: t.label, class: t.cls });
    else await this.#destroy(t, decision, req, res);
  }

  /** List, filter to the dead-hand scope, decide each delete through the engine, delete (or only report in dry-run). */
  async sweep(baseline: ReadonlySet<string> = this.d.baselineIds?.() ?? new Set()): Promise<SweepResult> {
    const res = emptySweep();
    const { targets, complete } = await this.#list(res);
    this.#confirmUnknown(new Set(targets.map((t) => t.id)), complete, res);
    for (const t of targets) {
      if (baseline.has(t.id)) { if (inDeadHandScope(t.cls, t.label)) res.protected_skipped.push(t.id); continue; }
      if (inDeadHandScope(t.cls, t.label)) await this.#handle(t, res);
    }
    return res;
  }

  #leaseState(now: number): { state: LeaseState; reason: string | null } {
    const lease = readLease(this.d.sharedDir, this.d.verifierUid === null ? {} : { uid: this.d.verifierUid });
    // a lease claiming more than the verifier's own ceiling is not trusted either (AG4-VER-2, defence in depth)
    if (lease && lease.ttl_s > DEFAULT_LEASE_MAX_TTL_S) return { state: 'LAPSED', reason: `over-ttl lease (${lease.ttl_s} s)` };
    const state = leaseState(lease, now, { startedAt: this.#startedAt, graceMs: this.d.leaseGraceMs ?? DEFAULT_GRACE_MS, everSeen: this.#everSeen, graceStale: this.d.bootGrace === true });
    if (state === 'ALIVE') this.#everSeen = true;
    return { state, reason: lease ? null : diagnoseLease(this.d.sharedDir, this.d.verifierUid) };
  }

  #publish(body: Record<string, unknown>): void {
    const tmp = join(this.d.sharedDir, `${STATUS_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o644 });
    renameSync(tmp, join(this.d.sharedDir, STATUS_FILE));
  }

  /** One tick: read the lease, sweep when it has lapsed, publish a status file (`/api/watchdog`). An ALIVE lease makes no Vultr call at all. */
  async tick(): Promise<TickStatus> {
    const now = this.#now();
    const { state, reason } = this.#leaseState(now);
    let status: TickStatus = state === 'LAPSED' ? 'DESTROYING' : state;
    let sweep: SweepResult | null = null;
    let baseline: 'ok' | 'unavailable' = 'ok';
    if (state === 'LAPSED') {
      const ids = this.d.baselineIds?.() ?? null;
      if (ids === null) baseline = 'unavailable';
      sweep = await this.sweep(ids ?? new Set());
      status = sweep.errors.length > 0 ? 'DEGRADED' : sweep.destroyed.length === 0 && sweep.would_delete.length === 0 ? 'DONE' : 'DESTROYING';
    }
    this.#publish({ status, lease: state, lease_reason: reason, at: now, ever_seen: this.#everSeen, dry_run: this.d.dryRun, baseline, would_delete: sweep?.would_delete ?? [], sweep });
    return status;
  }
}

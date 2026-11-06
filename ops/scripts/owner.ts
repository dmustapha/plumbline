// File: ops/scripts/owner.ts
// The owner machine's way to touch Vultr. Two doors, both recorded in a durable ledger:
//   1. resource mutations (instance/registry/bucket object) take an engine ALLOW minted under the OWNER policy (caller 'owner');
//   2. account mutations (users, keys, ip allow, bucket creation, subscription delete) take an OwnerAction from mintOwnerAction.
// AG4-OPS-1: no raw mutation exists in ops scripts. Every ALLOW and every OwnerAction is written to the ledger db at the moment
// it is issued; a DENY is written too (a refusal is a fact), then thrown.
import { chmodSync, existsSync } from 'node:fs';
import { Ledger, openDb, recordDecision, recordEvent, type Db } from '@plumbline/ledger';
import {
  evaluate, parsePolicy, type AllowDecision, type CallRequest, type EngineState, type ResourceClass, type Verb,
} from '@plumbline/policy-engine';
import { OwnerAdmin, VultrHttp, mintOwnerAction, type OwnerAction, type OwnerActionRecord, type OwnerOp } from '@plumbline/vultr-adapter';

// 'system' is the one session proofCounts excludes, so owner bootstrap rows never inflate the attack counters.
export const OWNER_SESSION = 'system';
export const OWNER_TASK = 'bootstrap';
export const OWNER_ENV_FILE = '/Users/MAC/vultr-rush/.env';

const OWNER_POLICY = `version: 1
rules:
  - id: allow-list
    effect: allow
    priority: 10
    match: { verb: [list], class: [instance, firewall_group, vpc, registry, bucket_object] }
    reason: owner list
  - id: allow-breadth-create
    effect: allow
    priority: 10
    match: { verb: [create], class: [instance, firewall_group, vpc, registry], label_prefix: [plumbline] }
    reason: owner create
  - id: allow-breadth-delete
    effect: allow
    priority: 10
    match: { verb: [delete, update], class: [instance, firewall_group, vpc, registry], label_prefix: [plumbline] }
    reason: owner delete
  - id: allow-bucket-ops
    effect: allow
    priority: 10
    match: { verb: [put, restore, delete], class: [bucket_object], label_prefix: [plumbline] }
    reason: owner bucket
`;
const OWNER_FLOOR = `version: 1
rules:
  - id: scope-label-prefix
    effect: deny
    priority: 90
    match: { verb: [create, update, delete, put, restore], class: [instance, firewall_group, vpc, registry, bucket_object], label_not_prefix: [plumbline] }
    reason: owner scripts only touch plumbline resources
`;

const state = (now: number): EngineState => ({
  now_ms: now, rate_card: null, session_spent_usd: 0, session_ceiling_usd: 0, global_spent_usd: 0, global_cap_usd: 0, live_worker_count: 0, max_instances: 99,
  kill_switch: false, session_tier: 'standard', tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
  object_versions: null, restorable: null, bond: { enabled: false, free_usd: 0 },
});

export interface OwnerOptions {
  /** injected environment (tests); default: process.env after loading envFile */
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** durable ledger db the broker will adopt; ':memory:' for tests */
  ledgerPath?: string;
  now?: () => number;
}

export interface OwnerGrant {
  allow: AllowDecision;
  req: CallRequest;
  decision_id: string;
}

export interface AllowOptions {
  id?: string;
  params?: CallRequest['params'];
  tags?: string[];
}

function loadEnv(opts: OwnerOptions): NodeJS.ProcessEnv {
  if (opts.env) return opts.env;
  const file = opts.envFile ?? OWNER_ENV_FILE;
  if (existsSync(file)) process.loadEnvFile(file);
  return process.env;
}

function mustParse(text: string, layer: 'session' | 'floor') {
  const r = parsePolicy(text, layer);
  if (!r.ok) throw new Error(`owner ${layer} policy invalid`);
  return r.policy;
}

export function ownerContext(opts: OwnerOptions = {}) {
  const env = loadEnv(opts);
  const key = env.VULTR_API_KEY;
  if (!key) throw new Error('VULTR_API_KEY (owner key) is not set; run this from the owner machine');
  const clock = opts.now ?? Date.now;
  const db: Db = openDb(opts.ledgerPath ?? ':memory:');
  if (opts.ledgerPath && opts.ledgerPath !== ':memory:') chmodSync(opts.ledgerPath, 0o600);
  // The spend gate is a throwaway meter: owner infra is not session spend, so it must not leak 'owner' spend rows into the broker's db.
  const gate = new Ledger(openDb(':memory:'), { session_ceiling_usd: 1e6, global_cap_usd: 1e6 });
  const ledger = new Ledger(db, { session_ceiling_usd: 1e6, global_cap_usd: 1e6 }, clock);
  const http = new VultrHttp({ apiKey: key, gate, maxRps: 10, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
  const session = mustParse(OWNER_POLICY, 'session');
  const floor = mustParse(OWNER_FLOOR, 'floor');
  let seq = 0;

  const decisionIds = new Map<string, string>();

  /** Shape G1h's owner-port expects: judge a ready request under the owner policy, record the row, throw unless ALLOW. */
  const allow = (req: CallRequest): AllowDecision => {
    const d = evaluate(req, session, floor, state(clock()));
    const row = recordDecision(db, d, { session_id: OWNER_SESSION, task_id: OWNER_TASK, model: null, call: { owner: true, verb: req.verb, class: req.class, label: req.target.label }, vultr_ids: [], request: req }, clock());
    if (d.decision !== 'ALLOW') throw new Error(`owner call refused by the owner policy: ${d.rule_id}`);
    decisionIds.set(req.request_id, row.id);
    return d;
  };

  const grant = (verb: Verb, cls: ResourceClass, label: string, o: AllowOptions = {}): OwnerGrant => {
    seq += 1;
    const params: CallRequest['params'] = { ...(o.params ?? {}) };
    if (verb === 'create' && params.label === undefined) params.label = label;
    const req: CallRequest = {
      request_id: `owner-${clock().toString(36)}-${seq}`, task_id: OWNER_TASK, session_id: OWNER_SESSION, verb, class: cls, caller: 'owner',
      target: { id: o.id, label, tags: o.tags ?? [], resolved: o.id !== undefined }, params,
    };
    const d = allow(req);
    return { allow: d, req, decision_id: decisionIds.get(req.request_id) as string };
  };

  /** Written to the ledger events table at mint time (mintOwnerAction calls this before it hands the token out). */
  const record = (r: OwnerActionRecord): void => { recordEvent(db, 'owner_action', OWNER_SESSION, r, clock()); };

  /** AG4-OPS-1: the only way ops scripts get an OwnerAction. */
  const action = (op: OwnerOp, reason: string): OwnerAction => mintOwnerAction(op, reason, record, clock());

  const recordResource = (g: OwnerGrant, r: { id: string; class: ResourceClass; label: string; plan: string | null; protected: boolean }): void => {
    // ttl_h is ten years: the broker's TTL reaper selects every unexpired `instance` row, so infra rows must never look due.
    ledger.recordResource({ ...r, hourly: 0, ttl_h: 87_600, session_id: OWNER_SESSION, allow_decision_id: g.decision_id });
  };

  return {
    http, gate, db, ledger, admin: new OwnerAdmin(http), allow, grant, record, action, recordResource, ctx: { session_id: OWNER_SESSION },
    close: (): void => { db.close(); },
  };
}

export type OwnerContext = ReturnType<typeof ownerContext>;

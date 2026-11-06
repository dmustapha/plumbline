// File: apps/range-api/test/support.ts
import type { ApiConfig } from '../src/config.ts';
import { buildApi } from '../src/main.ts';
import type { ApiDeps } from '../src/deps.ts';

export const cfg: ApiConfig = {
  host: '127.0.0.1', port: 0, brokerSocket: '/x', runnerSocket: '/y', apiToken: 't', runnerToken: 'r', verifierUrl: null,
  evidenceDir: '/nonexistent', publicDir: new URL('../public', import.meta.url).pathname, keyExpiryIso: null, demoCaps: false, maxInFlight: 4,
  sessionsPerIp: 3, sessionWindowMs: 600_000, sessionsPerMinute: 10, maxSessions: 20, ipSpendCapUsd: 1.5,
};

export interface BrokerState {
  sessions: number;
  killed: boolean;
  spend: Record<string, number>;
  approvals: Record<string, { decision_id: string; nonce: string; call: { verb: string; class: string; id?: string } }[]>;
  approvalStatus: string;
  created: string[];
  /** Extra fields the scripted /v1/session answer carries (e.g. playground_error). */
  sessionExtra: Record<string, unknown>;
}

/** A scripted stand-in for the broker socket client: records every call, answers by path. */
export function fakeBroker(init: Partial<BrokerState> = {}) {
  const state: BrokerState = { sessions: 0, killed: false, spend: {}, approvals: {}, approvalStatus: 'DECIDED', created: [], sessionExtra: {}, ...init };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    calls.push({ method, path, body });
    if (path.startsWith('/v1/status')) return { status: 200, json: { kill_switch: { engaged: state.killed }, budget_left_pct: 90, sessions: state.sessions } };
    if (path === '/v1/session') {
      const sid = (0x1000 + state.created.length).toString(16).padStart(8, '0');
      state.created.push(sid);
      return { status: 200, json: { session_id: sid, tier: 'standard', playground: null, ...state.sessionExtra } };
    }
    if (path.startsWith('/v1/spend/')) return { status: 200, json: { session_usd: state.spend[path.slice('/v1/spend/'.length)] ?? 0 } };
    if (path.startsWith('/v1/approvals')) {
      const sid = new URL(path, 'http://x').searchParams.get('session_id') ?? '';
      return { status: 200, json: state.approvals[sid] ?? [] };
    }
    if (path.startsWith('/v1/approval/')) return { status: 200, json: { status: state.approvalStatus } };
    if (path.startsWith('/v1/policy-production')) return { status: 403, json: { status: 'SIG_REQUIRED' } };
    if (path.startsWith('/v1/decisions')) return { status: 200, json: [] };
    return { status: 200, json: {} };
  };
  return { state, calls, broker: { call, chat: async () => { throw new Error('OPERATOR_BUSY'); }, mint: async () => ({ task_id: 't', capability: 'c' }) } };
}

export const idleRunner = { run: async () => { throw new Error('OPERATOR_BUSY'); }, containers: async () => [] };

export async function makeApi(f: ReturnType<typeof fakeBroker>, over: Partial<ApiDeps> = {}, config: ApiConfig = cfg) {
  return buildApi(config, { broker: f.broker as never, runner: idleRunner as never, ...over });
}

export interface Opened { sid: string; key: string; headers: Record<string, string> }

/** Creates a session as the given client address and returns the id plus the one-time key header. */
export async function openSession(app: Awaited<ReturnType<typeof makeApi>>['app'], ip = '10.0.0.1'): Promise<Opened> {
  const r = await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': ip }, payload: {} });
  if (r.statusCode !== 200) throw new Error(`session create failed ${r.statusCode} ${r.body}`);
  const { session_id: sid, session_key: key } = r.json() as { session_id: string; session_key: string };
  return { sid, key, headers: { 'x-plumbline-session-id': sid, 'x-plumbline-session-key': key, 'x-forwarded-for': ip } };
}

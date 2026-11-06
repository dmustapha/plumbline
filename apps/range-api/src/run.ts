// File: apps/range-api/src/run.ts
import { runOperatorTask, type OperatorEvent, type TaskResult } from '@plumbline/operator';
import type { ApiDeps } from './deps.ts';

export interface DecisionRowLike {
  id: string; ts: number; decision: string; rule_id: string; layer: string; verb: string; class: string; model: string | null; task_id: string; session_id: string; detail_json: string;
}

interface Detail {
  reason?: string; layers?: unknown; policy_version?: string; projected_cost_usd?: number; call?: unknown; vultr_ids?: string[];
}

function detailOf(row: DecisionRowLike): Detail {
  try { return JSON.parse(row.detail_json) as Detail; } catch { return {}; }
}

/** A verdict card is built from a stored decision row, never from client data (INVARIANT 7, AC-ALL-1). */
export function card(row: DecisionRowLike) {
  const d = detailOf(row);
  return {
    decision_id: row.id, ts: row.ts, decision: row.decision, rule_id: row.rule_id, layer: row.layer, verb: row.verb, class: row.class, model: row.model,
    session_id: row.session_id, reason: d.reason ?? '', layers: d.layers ?? [], policy_version: d.policy_version ?? '', projected_cost_usd: d.projected_cost_usd ?? 0,
    quoted_call: d.call ?? null, vultr_ids: d.vultr_ids ?? [], task_id: row.task_id,
  };
}

/** Pushes the session's recent decisions, live list and spend to its SSE stream. A broker hiccup is reported, not thrown. */
export async function publishRecent(d: ApiDeps, sid: string, sinceTs: number): Promise<void> {
  try {
    const rows = await d.broker.call<DecisionRowLike[]>('GET', `/v1/decisions?session_id=${encodeURIComponent(sid)}&limit=20`);
    const list = Array.isArray(rows.json) ? rows.json : [];
    for (const row of [...list].reverse().filter((r) => r.ts >= sinceTs)) d.hub.publish(sid, 'verdict', card(row));
    const live = await d.broker.call('GET', `/v1/live-list?session_id=${encodeURIComponent(sid)}`);
    d.hub.publish(sid, 'livelist', live.json);
    const spend = await d.broker.call('GET', `/v1/spend/${encodeURIComponent(sid)}`);
    d.hub.publish(sid, 'spend', spend.json);
  } catch (e) {
    d.hub.publish(sid, 'stage', { stage: 'failed', status: 'BROKER_UNREACHABLE', detail: String((e as Error).message).slice(0, 100) });
  }
}

export async function execute(d: ApiDeps, sid: string, text: string, attackId: string): Promise<TaskResult | null> {
  const started = (d.clock ?? Date.now)();
  const onEvent = (e: OperatorEvent): void => { d.hub.publish(sid, 'stage', { attack_id: attackId, ...e }); };
  d.hub.publish(sid, 'stage', { attack_id: attackId, stage: 'start', text });
  try {
    const result = await runOperatorTask({ llm: d.broker as never, tasks: d.broker as never, sandbox: d.runner as never, onEvent, demoCaps: d.config.demoCaps }, sid, text);
    d.hub.publish(sid, 'result', { attack_id: attackId, status: result.status, models: result.models, attempts: result.attempts, advisory: result.advisory });
    await publishRecent(d, sid, started - 1000);
    return result;
  } catch (e) {
    d.hub.publish(sid, 'result', { attack_id: attackId, status: 'OPERATOR_BUSY', detail: String((e as Error).message).slice(0, 100) });
    return null;
  }
}

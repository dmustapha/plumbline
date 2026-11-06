// File: packages/ledger/src/spend.ts
import type { Db } from './db.ts';

export type SpendKind = 'vultr' | 's3' | 'vsi';

export interface SpendContext {
  session_id: string;
}

export interface Receipt {
  kind: SpendKind;
  estimate_usd: number;
  settle(actualUsd: number): void;
}

export type SpendResult =
  | { ok: true; receipt: Receipt; remaining_session: number; remaining_global: number }
  | { ok: false; reason: 'session-cap-exceeded' | 'global-cap-exceeded' | 'ledger-error' };

/** The only thing network adapters may hold: there is no bypass method on this interface. */
export interface SpendGate {
  charge(kind: SpendKind, estimateUsd: number, ctx: SpendContext): SpendResult;
}

export interface LedgerLimits {
  session_ceiling_usd: number;
  global_cap_usd: number;
}

export interface DisplaySpend {
  basis: 'BROKER ARITHMETIC';
  session_usd: number;
  inference_usd: number;
  global_usd: number;
  session_ceiling_usd: number;
  global_cap_usd: number;
  note: string;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * SEC-F4: a worker is a live, unprotected instance row that a session made. Selection is by class and protected, not by label, so an
 * instance created under any label counts toward the cap and is reaped. Bootstrap infrastructure (owner session 'system', plumbline-infra-*,
 * plumbline-prod-*) is excluded explicitly.
 */
export const LIVE_WORKER_WHERE = "class='instance' AND protected = 0 AND destroyed_at_ms IS NULL AND session_id <> 'system' AND label NOT LIKE 'plumbline-infra-%' AND label NOT LIKE 'plumbline-prod-%'";

export class Ledger implements SpendGate {
  constructor(
    private readonly db: Db,
    private readonly limits: LedgerLimits,
    private readonly clock: () => number = Date.now,
  ) {}

  sessionSpend(sessionId: string): number {
    const row = this.db.prepare('SELECT usd_resources AS v FROM spend WHERE session_id = ?').get(sessionId) as { v: number } | undefined;
    return round(row?.v ?? 0);
  }

  inferenceSpend(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(usd),0) AS v FROM inference_calls').get() as { v: number };
    return round(row.v);
  }

  globalSpend(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(usd_resources),0) AS v FROM spend').get() as { v: number };
    return round(row.v + this.inferenceSpend());
  }

  charge(kind: SpendKind, estimateUsd: number, ctx: SpendContext): SpendResult {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) return { ok: false, reason: 'ledger-error' };
    const sessionSpent = this.sessionSpend(ctx.session_id);
    const globalSpent = this.globalSpend();
    const remainingGlobal = round(this.limits.global_cap_usd - globalSpent);
    const remainingSession = round(this.limits.session_ceiling_usd - sessionSpent);
    if (estimateUsd > remainingGlobal) return { ok: false, reason: 'global-cap-exceeded' };
    if (kind !== 'vsi' && estimateUsd > remainingSession) return { ok: false, reason: 'session-cap-exceeded' };
    let settled = false;
    const add = (usd: number): void => {
      if (kind === 'vsi') return;
      this.db.prepare(
        'INSERT INTO spend(session_id, usd_resources) VALUES(?, ?) ON CONFLICT(session_id) DO UPDATE SET usd_resources = usd_resources + excluded.usd_resources',
      ).run(ctx.session_id, usd);
    };
    add(estimateUsd);
    const receipt: Receipt = {
      kind,
      estimate_usd: estimateUsd,
      settle: (actual: number) => {
        if (settled) return;
        settled = true;
        if (kind !== 'vsi') add(round(actual - estimateUsd));
      },
    };
    return { ok: true, receipt, remaining_session: round(remainingSession - estimateUsd), remaining_global: round(remainingGlobal - estimateUsd) };
  }

  recordInference(sessionId: string, model: string, promptTokens: number, completionTokens: number, usd: number): void {
    this.db.prepare('INSERT INTO inference_calls(ts, session_id, model, prompt_tokens, completion_tokens, usd) VALUES(?,?,?,?,?,?)')
      .run(this.clock(), sessionId, model, promptTokens, completionTokens, usd);
  }

  /** AG4-VER-1: a resource can only be recorded against an ALLOW decision of the same class (a made-up id or a DENY cannot back a row). */
  /** AG4-VER-1: a resource can only be recorded against an ALLOW decision of the same class (a made-up id or a DENY cannot back a row). */
  recordResource(r: { id: string; class: string; label: string; plan: string | null; hourly: number; ttl_h: number; protected: boolean; session_id: string; allow_decision_id: string }): void {
    const dec = this.db.prepare('SELECT decision, class FROM decisions WHERE id = ?').get(r.allow_decision_id) as { decision: string; class: string } | undefined;
    if (!dec || dec.decision !== 'ALLOW' || dec.class !== r.class) throw new Error('RESOURCE_NOT_TIED_TO_ALLOW');
    this.db.prepare(
      'INSERT OR REPLACE INTO resources(id,class,label,plan,hourly,created_at_ms,ttl_h,protected,session_id,allow_decision_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(r.id, r.class, r.label, r.plan, r.hourly, this.clock(), r.ttl_h, r.protected ? 1 : 0, r.session_id, r.allow_decision_id);
  }

  markDestroyed(id: string): void {
    this.db.prepare('UPDATE resources SET destroyed_at_ms = ? WHERE id = ? AND destroyed_at_ms IS NULL').run(this.clock(), id);
  }

  liveWorkerCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM resources WHERE ${LIVE_WORKER_WHERE}`).get() as { n: number };
    return row.n;
  }

  isKnownResource(id: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM resources WHERE id = ?').get(id) !== undefined;
  }

  display(sessionId: string): DisplaySpend {
    return {
      basis: 'BROKER ARITHMETIC',
      session_usd: this.sessionSpend(sessionId),
      inference_usd: this.inferenceSpend(),
      global_usd: this.globalSpend(),
      session_ceiling_usd: this.limits.session_ceiling_usd,
      global_cap_usd: this.limits.global_cap_usd,
      note: "from public hourly prices; Vultr's pending_charges rounds to whole cents with a 1-hour minimum",
    };
  }

  limitsView(): LedgerLimits {
    return { ...this.limits };
  }
}

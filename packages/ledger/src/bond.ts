// File: packages/ledger/src/bond.ts
// The bond is a per-session risk budget: one judge's slash never reduces another judge's free bond.
import type { Db } from './db.ts';

export interface BondSnapshot { free: number; held: number; burned: number }
export interface BondAction { action_id: string; amount: number; state: 'held' | 'released' | 'burned' }

export class Bond {
  constructor(private readonly db: Db, private readonly initialUsd: number) {}

  /** Lazily creates the session's row with the configured initial amount on first touch. */
  #touch(sid: string): void {
    this.db.prepare('INSERT OR IGNORE INTO bond_sessions(session_id, free, held, burned) VALUES (?, ?, 0, 0)').run(sid, this.initialUsd);
  }

  snapshot(sid: string): BondSnapshot {
    this.#touch(sid);
    return this.db.prepare('SELECT free, held, burned FROM bond_sessions WHERE session_id = ?').get(sid) as BondSnapshot;
  }

  freeUsd(sid: string): number {
    return this.snapshot(sid).free;
  }

  /** Counts only, never a free amount: the safe aggregate for a caller who names no session. */
  aggregate(): { sessions: number; held_actions: number; burned_actions: number } {
    const n = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      sessions: n('SELECT COUNT(*) AS n FROM bond_sessions'),
      held_actions: n("SELECT COUNT(*) AS n FROM bond_actions WHERE state = 'held'"),
      burned_actions: n("SELECT COUNT(*) AS n FROM bond_actions WHERE state = 'burned'"),
    };
  }

  /** Every hold with its state, for one session or (no argument) for all. */
  actions(sid?: string): BondAction[] {
    const sql = `SELECT action_id, amount, state FROM bond_actions ${sid === undefined ? '' : 'WHERE session_id = ?'} ORDER BY rowid`;
    const stmt = this.db.prepare(sql);
    return (sid === undefined ? stmt.all() : stmt.all(sid)) as BondAction[];
  }

  hold(sid: string, actionId: string, amount: number): boolean {
    return this.db.transaction((): boolean => {
      if (this.db.prepare('SELECT 1 AS x FROM bond_actions WHERE action_id = ?').get(actionId)) return false;
      if (amount <= 0 || amount > this.freeUsd(sid)) return false;
      this.db.prepare("INSERT INTO bond_actions(action_id, amount, state, session_id) VALUES (?,?, 'held', ?)").run(actionId, amount, sid);
      this.db.prepare('UPDATE bond_sessions SET free = ROUND(free - ?, 6), held = ROUND(held + ?, 6) WHERE session_id = ?').run(amount, amount, sid);
      return true;
    })();
  }

  release(actionId: string): boolean {
    return this.#settle(actionId, 'released', 'free = ROUND(free + ?, 6), held = ROUND(held - ?, 6)');
  }

  burn(actionId: string): boolean {
    return this.#settle(actionId, 'burned', 'held = ROUND(held - ?, 6), burned = ROUND(burned + ?, 6)');
  }

  #settle(actionId: string, state: 'released' | 'burned', set: string): boolean {
    return this.db.transaction((): boolean => {
      const row = this.db.prepare("SELECT amount, session_id FROM bond_actions WHERE action_id = ? AND state = 'held'").get(actionId) as { amount: number; session_id: string } | undefined;
      if (!row) return false;
      this.db.prepare('UPDATE bond_actions SET state = ? WHERE action_id = ?').run(state, actionId);
      this.db.prepare(`UPDATE bond_sessions SET ${set} WHERE session_id = ?`).run(row.amount, row.amount, row.session_id);
      return true;
    })();
  }
}

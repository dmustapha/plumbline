// File: packages/ledger/src/bond.ts
import type { Db } from './db.ts';

export class Bond {
  constructor(private readonly db: Db, initialUsd: number) {
    db.prepare('INSERT OR IGNORE INTO bond(id, free, held, burned) VALUES (1, ?, 0, 0)').run(initialUsd);
  }

  snapshot(): { free: number; held: number; burned: number } {
    return this.db.prepare('SELECT free, held, burned FROM bond WHERE id = 1').get() as { free: number; held: number; burned: number };
  }

  /** Every hold with its state: the ledger rows behind the hold, release and burn numbers. */
  actions(): { action_id: string; amount: number; state: 'held' | 'released' | 'burned' }[] {
    return this.db.prepare('SELECT action_id, amount, state FROM bond_actions ORDER BY rowid').all() as { action_id: string; amount: number; state: 'held' | 'released' | 'burned' }[];
  }

  freeUsd(): number {
    return this.snapshot().free;
  }

  hold(actionId: string, amount: number): boolean {
    const tx = this.db.transaction((): boolean => {
      if (this.db.prepare('SELECT 1 AS x FROM bond_actions WHERE action_id = ?').get(actionId)) return false;
      if (amount <= 0 || amount > this.freeUsd()) return false;
      this.db.prepare("INSERT INTO bond_actions(action_id, amount, state) VALUES (?,?, 'held')").run(actionId, amount);
      this.db.prepare('UPDATE bond SET free = ROUND(free - ?, 6), held = ROUND(held + ?, 6) WHERE id = 1').run(amount, amount);
      return true;
    });
    return tx();
  }

  release(actionId: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare("SELECT amount FROM bond_actions WHERE action_id = ? AND state = 'held'").get(actionId) as { amount: number } | undefined;
      if (!row) return false;
      this.db.prepare("UPDATE bond_actions SET state = 'released' WHERE action_id = ?").run(actionId);
      this.db.prepare('UPDATE bond SET free = ROUND(free + ?, 6), held = ROUND(held - ?, 6) WHERE id = 1').run(row.amount, row.amount);
      return true;
    });
    return tx();
  }

  burn(actionId: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare("SELECT amount FROM bond_actions WHERE action_id = ? AND state = 'held'").get(actionId) as { amount: number } | undefined;
      if (!row) return false;
      this.db.prepare("UPDATE bond_actions SET state = 'burned' WHERE action_id = ?").run(actionId);
      this.db.prepare('UPDATE bond SET held = ROUND(held - ?, 6), burned = ROUND(burned + ?, 6) WHERE id = 1').run(row.amount, row.amount);
      return true;
    });
    return tx();
  }
}

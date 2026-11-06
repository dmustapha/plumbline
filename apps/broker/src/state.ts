// File: apps/broker/src/state.ts
import type { Bond, Ledger } from '@plumbline/ledger';
import type { EngineState } from '@plumbline/policy-engine';
import type { RateCardCache, TierKeys } from '@plumbline/vultr-adapter';
import type { Config } from './config.ts';
import type { KillSwitch } from './killswitch.ts';
import type { SessionRegistry } from './sessions.ts';

export interface StateDeps {
  config: Config;
  ledger: Ledger;
  rate: RateCardCache;
  tiers: TierKeys;
  kill: KillSwitch;
  bond: Bond;
  sessions: SessionRegistry;
  clock: () => number;
}

export function buildState(d: StateDeps, sessionId: string, bucket: { versions: number | null } | null): EngineState {
  const limits = d.ledger.limitsView();
  const versions = bucket ? bucket.versions : null;
  return {
    now_ms: d.clock(),
    rate_card: d.rate.get(),
    session_spent_usd: d.ledger.sessionSpend(sessionId),
    session_ceiling_usd: limits.session_ceiling_usd,
    global_spent_usd: d.ledger.globalSpend(),
    global_cap_usd: limits.global_cap_usd,
    live_worker_count: d.ledger.liveWorkerCount(),
    max_instances: d.config.maxInstances,
    kill_switch: d.kill.engaged(),
    session_tier: d.sessions.tier(sessionId),
    tier_available: d.tiers.availability(),
    object_versions: versions,
    restorable: versions === null ? null : versions >= 2,
    bond: { enabled: d.config.bondEnabled, free_usd: d.bond.freeUsd() },
  };
}

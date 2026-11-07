// File: apps/verifier/src/main-watchdog.ts
// Wiring for the watchdog process (systemd unit `plumbline-watchdog`, user `plumbline-watchdog`, env file with only its own scoped key and
// the public policy key). Refuses to boot unless: it is not root and not the verifier user, the key is verifiably provisioning+firewall
// only (AG4-VER-7), and the production floor's detached signature verifies. Live deletes need an explicit PLUMBLINE_WATCHDOG_DRY_RUN=0.
import { loadWatchdogConfig } from './config.ts';
import { loadBaseline, loadFloor } from './sharedFiles.ts';
import { assertOwnUser, assertWatchdogKey, resolveDryRun, Watchdog } from './watchdog.ts';
import { makeHttp } from './vultr-lite.ts';

const MIN_TICK_MS = 500;
const MAX_TICK_MS = 30_000;

const config = loadWatchdogConfig(process.env);
assertOwnUser(process.getuid?.() ?? 0, config.verifierUid);
if (!Number.isFinite(config.tickMs) || config.tickMs < MIN_TICK_MS || config.tickMs > MAX_TICK_MS) {
  throw new Error(`BOOT_REFUSED: PLUMBLINE_WATCHDOG_TICK_MS must be ${MIN_TICK_MS}..${MAX_TICK_MS}`);
}
const http = makeHttp(config.deleteKey);
const acls = await assertWatchdogKey(http);
const loaded = loadFloor(config.floorPath, config.floorSigPath, config.policyPubkeyB64);
if (!loaded.floor) throw new Error(`BOOT_REFUSED: ${loaded.note ?? 'floor unavailable'}`);

const baselinePath = process.env.PLUMBLINE_BASELINE_PATH ?? '/etc/plumbline/baseline.json';
const baselineIds = (): ReadonlySet<string> | null => {
  const entries = loadBaseline(baselinePath);
  return entries === null ? null : new Set(entries.map((e) => e.id));
};
const dryRun = resolveDryRun(process.env);
const dog = new Watchdog({ http, floor: loaded.floor, sharedDir: config.sharedDir, dryRun, verifierUid: config.verifierUid, leaseGraceMs: config.leaseGraceMs, bootGrace: true, baselineIds });
console.log(JSON.stringify({ evt: 'watchdog-running', dry_run: dryRun, tick_ms: config.tickMs, key_acls: acls, floor: loaded.floor.hash.slice(0, 12) }));

let stop = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stop = true; });
while (!stop) {
  try {
    const s = await dog.tick();
    if (s === 'DESTROYING' || s === 'DEGRADED') console.log(JSON.stringify({ evt: 'watchdog', status: s, dry_run: dryRun }));
  } catch (e) {
    console.error(JSON.stringify({ evt: 'watchdog-error', msg: String((e as Error).message) }));
  }
  await new Promise((r) => setTimeout(r, config.tickMs));
}

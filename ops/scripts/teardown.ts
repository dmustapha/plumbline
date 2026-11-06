// File: ops/scripts/teardown.ts
// OPS-1: owner-only teardown. Lists everything it will delete, deletes nothing without --yes, and every delete goes through
// the engine (owner caller) or a minted OwnerAction, including the Object Storage subscription (deleteObjectStorage).
// Run only after the judging window (Dami's call). Usage: npm run teardown            (lists, exits 3)
//                                                          npm run teardown -- --yes   (deletes)
import { pathToFileURL } from 'node:url';
import { loadOwnerPort, type Item, type Kind, type OwnerPort } from './owner-port.ts';

/** Deletion order: instances first so groups and networks are free, the paid storage subscription last. */
const ORDER: Kind[] = ['instance', 'firewall_group', 'vpc', 'registry', 'user', 'object_storage'];

export interface TeardownDeps { port: OwnerPort; yes: boolean; log: (line: string) => void }
export interface TeardownResult { planned: Item[]; deleted: Item[]; failed: { item: Item; error: string }[]; confirmed: boolean }

export function orderItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export async function runTeardown(d: TeardownDeps): Promise<TeardownResult> {
  const planned = orderItems(await d.port.inventory());
  d.log(`teardown will delete ${planned.length} item(s):`);
  for (const i of planned) d.log(`  ${i.kind} ${i.label} (${i.id})`);
  if (!planned.some((i) => i.kind === 'object_storage')) d.log('  object_storage: not listed (set VULTR_OBJSTORE_ID to include the Object Storage subscription; it keeps billing until deleted)');
  if (!d.yes) {
    d.log('NOT CONFIRMED: nothing deleted. Re-run with --yes after the judging window.');
    return { planned, deleted: [], failed: [], confirmed: false };
  }
  const deleted: Item[] = [];
  const failed: { item: Item; error: string }[] = [];
  for (const item of planned) {
    try { await d.port.remove(item, `teardown ${item.kind} ${item.label}`); deleted.push(item); d.log(`deleted ${item.kind} ${item.label}`); }
    catch (e) { failed.push({ item, error: String((e as Error).message).slice(0, 160) }); d.log(`FAILED ${item.kind} ${item.label}: ${(e as Error).message}`); }
  }
  return { planned, deleted, failed, confirmed: true };
}

export const exitCodeFor = (r: TeardownResult): number => (!r.confirmed ? 3 : r.failed.length > 0 ? 1 : 0);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runTeardown({ port: await loadOwnerPort(), yes: process.argv.includes('--yes'), log: (l) => console.log(l) });
  console.log(JSON.stringify({ deleted: result.deleted.length, failed: result.failed.length, confirmed: result.confirmed }));
  process.exit(exitCodeFor(result));
}

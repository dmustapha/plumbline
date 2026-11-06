// File: apps/verifier/src/sharedFiles.ts
// Small readers for the files the verifier trusts but does not write: baseline manifest, watchdog destroy log, production floor,
// and the verifier's own continuity pin. Every reader fails closed (null / empty / a note), never throws on bad content.
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePolicy, verifyPolicySignature, type PolicyDoc } from '@plumbline/policy-engine';
import type { BaselineEntry, DestroyedEntry, Pin } from './reconcile.ts';

const CLASSES = ['instance', 'vpc', 'registry'];

function validEntry(e: unknown): e is BaselineEntry {
  const b = e as Partial<BaselineEntry> | null;
  return typeof b?.id === 'string' && b.id !== '' && typeof b.label === 'string' && typeof b.region === 'string'
    && typeof b.plan === 'string' && typeof b.class === 'string' && CLASSES.includes(b.class);
}

/** AG4-VER-8: a missing, unparseable or malformed baseline is null (the verdict is then DEGRADED), never an empty list */
export function loadBaseline(path: string): BaselineEntry[] | null {
  try {
    const raw = (JSON.parse(readFileSync(path, 'utf8')) as { resources?: unknown }).resources;
    return Array.isArray(raw) && raw.every(validEntry) ? raw : null;
  } catch {
    return null;
  }
}

export interface DestroyedLog {
  entries: DestroyedEntry[];
  /** set when the whole file was refused */
  rejected?: string;
}

function logRefusal(file: string, uid: number | null): string | null {
  const st = lstatSync(file);
  if (!st.isFile()) return 'not a regular file (symlink?)';
  if ((st.mode & 0o002) !== 0) return 'world-writable';
  if (uid !== null && st.uid !== uid) return `owned by uid ${st.uid}, expected the watchdog uid ${uid}`;
  return null;
}

/**
 * AG4-VER-4: the watchdog's destroy log excuses RECONCILE_RED_MISSING. It is honoured only if it is a regular file that is not
 * world-writable and (when configured) owned by the watchdog uid. The caller additionally requires ts >= the ALLOW row's creation.
 */
export function readDestroyed(sharedDir: string, watchdogUid: number | null): DestroyedLog {
  const file = join(sharedDir, 'watchdog-actions.jsonl');
  if (!existsSync(file)) return { entries: [] };
  try {
    const refusal = logRefusal(file, watchdogUid);
    if (refusal) return { entries: [], rejected: `watchdog-actions.jsonl ignored: ${refusal}` };
    const entries: DestroyedEntry[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const x = parseLine(line);
      if (x) entries.push(x);
    }
    return { entries };
  } catch {
    return { entries: [], rejected: 'watchdog-actions.jsonl unreadable' };
  }
}

function parseLine(line: string): DestroyedEntry | null {
  if (!line) return null;
  try {
    const x = JSON.parse(line) as { act?: unknown; id?: unknown; ts?: unknown };
    return x.act === 'destroyed' && typeof x.id === 'string' && typeof x.ts === 'number' && Number.isFinite(x.ts) ? { id: x.id, ts: x.ts } : null;
  } catch {
    return null;
  }
}

export interface FloorLoad {
  floor: PolicyDoc | null;
  note?: string;
}

/** The floor is the repository file on VM 2. With a policy public key configured its detached signature must verify (BOOT_REFUSED otherwise). */
export function loadFloor(path: string, sigPath: string, pubkeyB64: string | null): FloorLoad {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { floor: null, note: `floor unreadable at ${path}` };
  }
  if (pubkeyB64) {
    const sig = existsSync(sigPath) ? readFileSync(sigPath, 'utf8').trim() : undefined;
    const status = verifyPolicySignature(text, sig, pubkeyB64);
    if (status !== 'OK') throw new Error(`BOOT_REFUSED: production floor signature ${status}`);
  }
  const parsed = parsePolicy(text, 'floor');
  return parsed.ok ? { floor: parsed.policy } : { floor: null, note: 'floor invalid' };
}

const PIN_FILE = 'ledger-pin.json';

export function readPin(stateDir: string): Pin | null {
  try {
    const p = JSON.parse(readFileSync(join(stateDir, PIN_FILE), 'utf8')) as Partial<Pin>;
    return Number.isInteger(p.seq) && typeof p.row_hash === 'string' ? { seq: p.seq as number, row_hash: p.row_hash } : null;
  } catch {
    return null;
  }
}

export function writePin(stateDir: string, pin: Pin): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = join(stateDir, `${PIN_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(pin), { mode: 0o600 });
  renameSync(tmp, join(stateDir, PIN_FILE));
}

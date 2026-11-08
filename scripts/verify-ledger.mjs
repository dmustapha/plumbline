#!/usr/bin/env node
// File: scripts/verify-ledger.mjs
// Checks a Plumbline ledger export without trusting any Plumbline server. No dependencies, Node 18+.
//   curl -s https://plumbline.108-61-70-169.sslip.io/api/ledger/public -o ledger.json
//   node scripts/verify-ledger.mjs ledger.json [--pin SEQ:ROWHASH]
// Rules (the same ones the in-browser check on /audit/ledger and apps/verifier use):
//   row_hash = sha256(prev_hash + "\n" + canonical JSON of the row without prev_hash and row_hash); the first prev_hash is 64 zeros;
//   decisions, then resources, then unknown outcomes form ONE chain whose last hash is chain_head.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = (t) => createHash('sha256').update(t).digest('hex');
const GENESIS = '0'.repeat(64);
function canon(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (typeof v === 'object') { const ks = Object.keys(v).filter((k) => v[k] !== undefined).sort(); return '{' + ks.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'; }
  throw new Error('unsupported value');
}
function walk(rows, start) {
  let prev = start;
  for (let i = 0; i < rows.length; i++) {
    const { prev_hash: ph, row_hash: rh, ...body } = rows[i];
    if (ph !== prev) return { ok: false, at: i, why: 'its link to the row before it is wrong' };
    if (sha(prev + '\n' + canon(body)) !== rh) return { ok: false, at: i, why: 'its contents were changed after it was recorded' };
    prev = rh;
  }
  return { ok: true, head: prev };
}

export function verify(exp, pin) {
  const out = []; const say = (ok, msg) => { out.push({ ok, msg }); return ok; };
  if (!exp || exp.schema !== 'plumbline-ledger-export/v2' || !Array.isArray(exp.decisions) || !Array.isArray(exp.resources) || !Array.isArray(exp.unknown_outcomes)) { say(false, 'not a Plumbline ledger export (v2)'); return out; }
  say(true, 'format: Plumbline ledger export, schema v2');
  const dec = exp.decisions;
  const d = walk(dec, GENESIS);
  if (!say(d.ok, d.ok ? `${dec.length} decisions chained` : `decision #${dec[d.at].seq}: ${d.why}`)) return out;
  const gap = dec.findIndex((r, i) => r.seq !== i + 1);
  if (!say(gap < 0 && exp.decision_count === dec.length, gap < 0 && exp.decision_count === dec.length ? `numbered 1 to ${dec.length}, nothing missing` : 'a decision is missing or renumbered')) return out;
  const r = walk(exp.resources, d.head);
  if (!say(r.ok, r.ok ? `${exp.resources.length} resource records continue the chain` : `resource record ${r.at + 1}: ${r.why}`)) return out;
  const u = walk(exp.unknown_outcomes, r.head);
  if (!say(u.ok, u.ok ? `${exp.unknown_outcomes.length} unresolved-outcome records continue it` : `unresolved-outcome record ${u.at + 1}: ${u.why}`)) return out;
  if (!say(exp.chain_head === u.head, exp.chain_head === u.head ? `chain head ${u.head.slice(0, 12)}... matches the last row` : 'published chain head does not match the rows')) return out;
  const byId = new Map(dec.map((x) => [x.id, x]));
  const loose = exp.resources.find((x) => { const a = byId.get(x.allow_decision_id); return !a || a.decision !== 'ALLOW' || x.allow_decision_kind !== 'ALLOW' || a.request_hash !== x.allow_request_hash; });
  if (!say(!loose, loose ? `resource ${loose.id} is not tied to an ALLOW decision` : 'every created resource is tied to the ALLOW decision that authorised it')) return out;
  let n = 0; let bad = null;
  for (const x of dec) { if (!x.request) continue; const q = x.request; n++; if (sha(canon({ verb: q.verb, class: q.class, target_id: (q.target && q.target.id) || null, params: q.params || {} })) !== x.request_hash) { bad = x; break; } }
  if (!say(!bad, bad ? `decision #${bad.seq}: recorded request does not match its fingerprint` : `${n} recorded requests match the fingerprints the verdicts were made on`)) return out;
  if (pin) { const p = dec[pin.seq - 1]; say(!!p && p.row_hash === pin.row_hash, p && p.row_hash === pin.row_hash ? `matches the head pinned at decision #${pin.seq}` : `does not match the pin at decision #${pin.seq}: history was rewritten`); }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('verify-ledger.mjs')) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/verify-ledger.mjs ledger.json [--pin SEQ:ROWHASH]'); process.exit(2); }
  const pi = process.argv.indexOf('--pin'); const [ps, ph] = pi > 0 ? String(process.argv[pi + 1]).split(':') : [];
  const res = verify(JSON.parse(readFileSync(file, 'utf8')), ps ? { seq: Number(ps), row_hash: ph } : null);
  for (const s of res) console.log((s.ok ? 'PASS ' : 'FAIL ') + s.msg);
  const ok = res.every((s) => s.ok); console.log(ok ? 'LEDGER OK' : 'LEDGER FAILED'); process.exit(ok ? 0 : 1);
}

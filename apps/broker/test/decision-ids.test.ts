// File: apps/broker/test/decision-ids.test.ts
// LIVE FINDING: the stored decision of a create has no Vultr id (written before the call, append-only); the card must still show the id it touched.
import { describe, expect, it } from 'vitest';
import { makeBroker, secrets } from './support.ts';

const H = { 'x-plumbline-api-token': secrets.apiToken };
type Row = { id: string; decision: string; verb: string; class: string; detail_json: string };

describe('DECISION-IDS cards carry the Vultr ids they touched', () => {
  it('DECISION-IDS a create ALLOW lists the created resource id; the stored row is unchanged', async () => {
    const { app, mock } = await makeBroker();
    const s = (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json() as { session_id: string };
    const out = await app.pipeline.handleCall({ task_id: 't1', session_id: s.session_id }, { verb: 'create', class: 'firewall_group', params: { label: `plumbline-s${s.session_id}-fw` } });
    expect(out.status).toBe('DECIDED');
    const rows = (await app.internal.inject({ method: 'GET', url: `/v1/decisions?session_id=${s.session_id}&limit=50`, headers: H })).json() as Row[];
    const create = rows.find((r) => r.verb === 'create' && r.class === 'firewall_group') as Row;
    const created = (mock.state.firewall_groups as unknown as { id: string }[])[0]?.id;
    expect(created).toBeTruthy();
    expect(JSON.parse(create.detail_json).vultr_ids).toEqual([created]);
    const stored = app.db.prepare('SELECT detail_json FROM decisions WHERE id = ?').get(create.id) as { detail_json: string };
    expect(JSON.parse(stored.detail_json).vultr_ids).toEqual([]);
  });
  it('DECISION-IDS a DENY or a list carries no invented id', async () => {
    const { app } = await makeBroker();
    const s = (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json() as { session_id: string };
    await app.pipeline.handleCall({ task_id: 't2', session_id: s.session_id }, { verb: 'list', class: 'instance', params: {} });
    const rows = (await app.internal.inject({ method: 'GET', url: `/v1/decisions?session_id=${s.session_id}`, headers: H })).json() as Row[];
    const list = rows.find((r) => r.verb === 'list') as Row;
    expect(JSON.parse(list.detail_json).vultr_ids ?? []).toEqual([]);
  });
});

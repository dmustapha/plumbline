// Stateful in-memory Vultr for the G1d bootstrap tests. Never selectable in a deployed build (tests only).
import { randomBytes } from 'node:crypto';

interface FakeUser { id: string; name: string; acls: string[]; ips: string[]; keys: string[] }
interface FakeInstance { id: string; label: string; plan: string; region: string; tags: string[]; polls: number; ip: string; power_status: string }

export function createFakeVultr() {
  const st = {
    users: [] as FakeUser[], instances: [] as FakeInstance[], registries: [] as { id: string; name: string; region: string }[],
    calls: [] as { method: string; path: string }[], issued: 0, seq: 0, activeAfterPolls: 2,
    versions: new Map<string, { VersionId: string; Key: string; IsLatest: boolean; Size: number }[]>(), s3: [] as string[],
  };
  const json = (status: number, body: unknown): Response =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const view = (i: FakeInstance) => {
    const active = i.polls >= st.activeAfterPolls;
    return { id: i.id, label: i.label, plan: i.plan, region: i.region, tags: i.tags, status: active ? 'active' : 'pending', server_status: active ? 'ok' : 'none', power_status: i.power_status, main_ip: active ? i.ip : '0.0.0.0', os: 'Debian 12 x64 (bookworm)', os_id: 2136, date_created: 'now', firewall_group_id: '' };
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/v2', '');
    st.calls.push({ method, path });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === '/plans') return json(200, { plans: [{ id: 'vc2-1c-1gb', locations: ['ewr', 'ord', 'lax'] }, { id: 'vc2-2c-4gb', locations: ['ewr'] }] });
    if (path === '/instances' && method === 'GET') return json(200, { instances: st.instances.map((i) => view(i)) });
    if (path === '/instances' && method === 'POST') {
      st.seq += 1;
      const inst: FakeInstance = { id: `inst-${st.seq}`, label: String(body.label), plan: String(body.plan), region: String(body.region), tags: (body.tags as string[]) ?? [], polls: 0, ip: `203.0.113.${st.seq}`, power_status: 'running' };
      st.instances.push(inst);
      return json(202, { instance: view(inst) });
    }
    const one = /^\/instances\/([^/]+)$/.exec(path);
    if (one && method === 'GET') {
      const inst = st.instances.find((i) => i.id === one[1]);
      if (!inst) return json(404, { error: 'not found' });
      inst.polls += 1;
      return json(200, { instance: view(inst) });
    }
    if (path === '/registries') return json(200, { registries: st.registries.map((r) => ({ ...r, urn: `ewr.vultrcr.com/${r.name}` })) });
    if (path === '/registry' && method === 'POST') {
      st.seq += 1;
      const r = { id: `reg-${st.seq}`, name: String(body.name), region: String(body.region) };
      st.registries.push(r);
      return json(201, { registry: { ...r, urn: `ewr.vultrcr.com/${r.name}` } });
    }
    if (path === '/users' && method === 'GET') return json(200, { users: st.users.map((u) => ({ id: u.id, name: u.name, acls: u.acls })) });
    if (path === '/users' && method === 'POST') {
      if (typeof body.password !== 'string' || body.password.length < 12) return json(400, { error: 'Bad request.' }); // live: Vultr 400s without a password
      st.seq += 1;
      const u: FakeUser = { id: `user-${st.seq}`, name: String(body.name), acls: (body.acls as string[]) ?? [], ips: [], keys: [] };
      st.users.push(u);
      return json(201, { user: { id: u.id, name: u.name } });
    }
    const um = /^\/users\/([^/]+)(\/apikeys|\/ip-whitelist)?$/.exec(path);
    const user = um ? st.users.find((u) => u.id === um[1]) : undefined;
    if (um && !user) return json(404, { error: 'not found' });
    if (user && um?.[2] === '/apikeys' && method === 'POST') {
      st.issued += 1;
      const key = `FAKEKEY-${st.issued}-${randomBytes(8).toString('hex')}`;
      user.keys.push(key);
      return json(201, { api_key: key });
    }
    if (user && um?.[2] === '/ip-whitelist' && method === 'POST') { user.ips.push(String(body.subnet)); return json(204, null); }
    if (user && um?.[2] === '/ip-whitelist') return json(200, { ip_whitelist: user.ips.map((subnet) => ({ subnet, subnet_size: 32 })) });
    if (user && method === 'DELETE') { st.users.splice(st.users.indexOf(user), 1); return json(204, null); }
    return json(404, { error: `unhandled ${method} ${path}` });
  }) as typeof fetch;
  const s3 = {
    async send(command: unknown): Promise<unknown> {
      const name = (command as object).constructor.name;
      const input = (command as { input: { Key?: string; Prefix?: string } }).input;
      st.s3.push(name);
      if (name === 'ListObjectVersionsCommand') return { Versions: st.versions.get(input.Prefix as string) ?? [], IsTruncated: false };
      if (name === 'PutObjectCommand') {
        const key = input.Key as string;
        const list = (st.versions.get(key) ?? []).map((v) => ({ ...v, IsLatest: false }));
        const v = { VersionId: `v${list.length + 1}`, Key: key, IsLatest: true, Size: 1 };
        st.versions.set(key, [...list, v]);
        return { VersionId: v.VersionId };
      }
      return {};
    },
  };
  return { fetch: fetchImpl, state: st, s3 };
}

export type FakeVultr = ReturnType<typeof createFakeVultr>;

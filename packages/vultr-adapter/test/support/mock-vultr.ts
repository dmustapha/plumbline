// File: packages/vultr-adapter/test/support/mock-vultr.ts
export interface MockOptions {
  viewKeys?: string[];
  rateLimitAfter?: number;
  planHourly?: Record<string, number>;
  /** keys that get 401 on every call (IP lock) */
  unauthorizedKeys?: string[];
  /** per-key allow predicate for 'METHOD /path'; unlisted keys may do everything */
  acl?: Record<string, (method: string, path: string) => boolean>;
  /** shape of the POST /users/:id/apikeys answer */
  apiKeyShape?: 'top-level' | 'nested';
}

interface Item { id: string; [k: string]: unknown }

export function createMockVultr(opts: MockOptions = {}) {
  const state = {
    instances: [] as Item[], firewall_groups: [] as Item[], vpcs: [] as Item[], registries: [] as Item[],
    calls: [] as { method: string; path: string; key: string }[], seq: 0, nextCreateStatus: 202,
  };
  const json = (status: number, body: unknown): Response =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace('Bearer ', '');
    const path = url.pathname.replace('/v2', '');
    state.calls.push({ method, path, key });
    if (opts.rateLimitAfter !== undefined && state.calls.length > opts.rateLimitAfter && state.calls.length <= opts.rateLimitAfter + 2) {
      return new Response('{"error":"rate"}', { status: 429, headers: { 'retry-after': '0' } });
    }
    if ((opts.unauthorizedKeys ?? []).includes(key)) return json(401, { error: 'Unauthorized IP address' });
    const allowed = opts.acl?.[key];
    if (allowed && !allowed(method, path)) return json(403, { error: 'Permission denied. You do not have the required IAM permissions for this action.' });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === '/plans') {
      const hourly = opts.planHourly ?? { 'vc2-1c-1gb': 0.007, 'vc2-2c-4gb': 0.027 };
      return json(200, { plans: Object.entries(hourly).map(([id, hourly_cost]) => ({ id, hourly_cost })) });
    }
    const readOnly = (opts.viewKeys ?? []).includes(key);
    if (method !== 'GET' && readOnly) {
      return json(403, { error: 'Permission denied. You do not have the required IAM permissions for this action.' });
    }
    // LIVE: POST /vpcs answers 400 'Missing v4_subnet_mask' (not v4_subnet_size)
    if (method === 'POST' && path === '/vpcs' && (!body.v4_subnet_mask || !body.v4_subnet || !body.region)) return json(400, { error: 'Missing v4_subnet_mask', status: 400 });
    const collections: Record<string, { list: Item[]; field: string; one: string }> = {
      '/instances': { list: state.instances, field: 'instances', one: 'instance' },
      '/firewalls': { list: state.firewall_groups, field: 'firewall_groups', one: 'firewall_group' },
      '/vpcs': { list: state.vpcs, field: 'vpcs', one: 'vpc' },
      '/registries': { list: state.registries, field: 'registries', one: 'registry' },
      '/registry': { list: state.registries, field: 'registries', one: 'registry' },
    };
    if (method === 'POST' && /^\/users\/[^/]+\/apikeys$/.test(path)) {
      state.seq += 1;
      const k = { api_key: `REAL-KEY-${state.seq}`, date_expire: String(body.date_expire ?? '') };
      return json(201, opts.apiKeyShape === 'nested' ? { api_key: k } : k);
    }
    if (method === 'POST' && /^\/firewalls\/[^/]+\/rules$/.test(path)) return json(201, { firewall_rule: { id: 1, ...body } });
    if (method === 'POST' && path === '/users') {
      state.seq += 1;
      if (!body.name) return json(400, { error: 'name required' });
      if (typeof body.password !== 'string' || body.password.length < 12) return json(400, { error: 'Bad request.' }); // live: Vultr 400s without a password
      return json(201, { user: { id: `user-${state.seq}`, ...body } });
    }
    if (method === 'POST' && /^\/users\/[^/]+\/ip-whitelist$/.test(path)) return json(204, null);
    if (method === 'DELETE' && /^\/(users|object-storage)\/[^/]+$/.test(path)) return json(204, null);
    if (method === 'GET' && path === '/users') return json(200, { users: [] });
    if (method === 'POST' && path === '/firewalls' && !body.description) return json(400, { error: 'description required' });
    if (method === 'POST' && path === '/instances' && String(body.plan).includes('invalid')) return json(400, { error: 'invalid plan' });
    const [, root, id] = path.match(/^(\/[a-z]+)(?:\/([^/]+))?$/) ?? [];
    const col = root ? collections[root] : undefined;
    if (!col || !root) return json(404, { error: 'not found' });
    if (method === 'GET') return json(200, { [col.field]: col.list, meta: { total: col.list.length } });
    if (method === 'POST') {
      state.seq += 1;
      const item: Item = { id: `${col.one}-${state.seq}`, status: 'pending', power_status: 'running', server_status: 'none', date_created: new Date().toISOString(), ...body };
      if (root === '/instances') item.default_password = 'SECRET-SHOULD-BE-REDACTED';
      col.list.push(item);
      return json(root === '/instances' ? state.nextCreateStatus : 201, { [col.one]: item });
    }
    if (method === 'DELETE' && id) {
      const i = col.list.findIndex((x) => x.id === id);
      if (i < 0) return json(404, { error: 'not found' });
      col.list.splice(i, 1);
      return json(204, null);
    }
    return json(400, { error: 'unsupported' });
  }) as typeof fetch;
  return { fetch: fetchImpl, state };
}

// File: packages/vultr-adapter/src/users.ts
import type { Tier } from '@plumbline/policy-engine';
import type { VultrHttp } from './http.ts';

type Raw = Record<string, unknown>;

export interface IssuedKey {
  user_id: string;
  api_key: string;
  date_expire: string | null;
}

export class OwnerAdmin {
  constructor(private readonly http: VultrHttp) {}

  async createServiceUser(name: string, acls: string[]): Promise<{ id: string }> {
    const res = await this.http.request<{ user: Raw }>('POST', '/users', {
      session_id: 'system',
      body: { name, email: `${name}@plumbline.invalid`, service_user: true, api_enabled: true, acls },
    });
    return { id: String(res.user.id) };
  }

  async issueKey(userId: string, name: string, expireIso: string): Promise<IssuedKey> {
    const res = await this.http.request<Raw>('POST', `/users/${encodeURIComponent(userId)}/apikeys`, {
      session_id: 'system',
      body: { name, expire: true, date_expire: expireIso },
    });
    const k = (res.api_key as Raw | undefined) ?? res;
    return { user_id: userId, api_key: String(k.api_key ?? ''), date_expire: k.date_expire ? String(k.date_expire) : null };
  }

  async ipAllow(userId: string, ip: string): Promise<void> {
    await this.http.request('POST', `/users/${encodeURIComponent(userId)}/ip-whitelist`, { session_id: 'system', body: { subnet: ip, subnet_size: 32 } });
  }

  async ipList(userId: string): Promise<Raw[]> {
    const res = await this.http.request<{ ip_whitelist?: Raw[]; whitelist?: Raw[] }>('GET', `/users/${encodeURIComponent(userId)}/ip-whitelist`, { session_id: 'system' });
    return res.ip_whitelist ?? res.whitelist ?? [];
  }

  async deleteUser(userId: string): Promise<void> {
    await this.http.request('DELETE', `/users/${encodeURIComponent(userId)}`, { session_id: 'system' });
  }

  async listUsers(): Promise<{ id: string; name: string; acls: string[] }[]> {
    const res = await this.http.request<{ users?: Raw[] }>('GET', '/users', { session_id: 'system' });
    return (res.users ?? []).map((u) => ({ id: String(u.id), name: String(u.name ?? ''), acls: Array.isArray(u.acls) ? (u.acls as unknown[]).map(String) : [] }));
  }
}

export const TIER_ACL: Record<Tier, string> = {
  observer: 'subscriptions_view',
  deployer: 'provisioning',
  network: 'firewall',
  objstore: 'objstore',
  registry: 'registry',
};

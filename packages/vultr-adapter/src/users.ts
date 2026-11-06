// File: packages/vultr-adapter/src/users.ts
import { randomBytes } from 'node:crypto';
import type { Tier } from '@plumbline/policy-engine';
import type { VultrHttp } from './http.ts';
import { consumeOwnerAction, type OwnerAction } from './owner-action.ts';

type Raw = Record<string, unknown>;

export interface IssuedKey {
  user_id: string;
  api_key: string;
  date_expire: string | null;
}

export class OwnerAdmin {
  constructor(private readonly http: VultrHttp) {}

  async createServiceUser(auth: OwnerAction, name: string, acls: string[]): Promise<{ id: string }> {
    consumeOwnerAction(auth, 'user.create');
    const res = await this.http.request<{ user: Raw }>('POST', '/users', {
      session_id: 'system',
      // Vultr answers 400 without a password even for service users (live probe 2026-11-06). Never logged, never stored: the user authenticates by API key only.
      body: { name, email: `${name}@plumbline.invalid`, service_user: true, api_enabled: true, acls, password: `${randomBytes(24).toString('base64url')}-Aa1!` },
    });
    return { id: String(res.user.id) };
  }

  async issueKey(auth: OwnerAction, userId: string, name: string, expireIso: string): Promise<IssuedKey> {
    consumeOwnerAction(auth, 'user.issue_key');
    const res = await this.http.request<Raw>('POST', `/users/${encodeURIComponent(userId)}/apikeys`, {
      session_id: 'system',
      body: { name, expire: true, date_expire: expireIso },
    });
    const nested = res.api_key !== null && typeof res.api_key === 'object' ? (res.api_key as Raw) : null;
    const apiKey = nested ? nested.api_key : res.api_key;
    const expire = nested ? nested.date_expire : res.date_expire;
    if (typeof apiKey !== 'string' || apiKey === '') throw new Error('ISSUE_KEY_EMPTY: Vultr returned no api_key');
    return { user_id: userId, api_key: apiKey, date_expire: expire ? String(expire) : null };
  }

  async ipAllow(auth: OwnerAction, userId: string, ip: string): Promise<void> {
    consumeOwnerAction(auth, 'user.ip_allow');
    await this.http.request('POST', `/users/${encodeURIComponent(userId)}/ip-whitelist`, { session_id: 'system', body: { subnet: ip, subnet_size: 32 } });
  }

  async ipList(userId: string): Promise<Raw[]> {
    const res = await this.http.request<{ ip_whitelist?: Raw[]; whitelist?: Raw[] }>('GET', `/users/${encodeURIComponent(userId)}/ip-whitelist`, { session_id: 'system' });
    return res.ip_whitelist ?? res.whitelist ?? [];
  }

  async deleteUser(auth: OwnerAction, userId: string): Promise<void> {
    consumeOwnerAction(auth, 'user.delete');
    await this.http.request('DELETE', `/users/${encodeURIComponent(userId)}`, { session_id: 'system' });
  }

  /** AG4-ADP-3: the raw Object Storage subscription DELETE lives here, behind an OwnerAction, not in ops scripts. */
  async deleteObjectStorage(auth: OwnerAction, subscriptionId: string): Promise<void> {
    consumeOwnerAction(auth, 'objstore.delete');
    await this.http.request('DELETE', `/object-storage/${encodeURIComponent(subscriptionId)}`, { session_id: 'system' });
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

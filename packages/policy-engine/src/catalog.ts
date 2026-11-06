// File: packages/policy-engine/src/catalog.ts
import type { ResourceClass, Tier, Verb } from './types.ts';

export const VERB_CLASS: Record<ResourceClass, readonly Verb[]> = {
  instance: ['list', 'create', 'update', 'delete'],
  firewall_group: ['list', 'create', 'update', 'delete'],
  vpc: ['list', 'create', 'delete'],
  registry: ['list', 'create', 'delete'],
  bucket_object: ['list', 'put', 'restore', 'delete'],
  http: ['fetch'],
  policy: ['read', 'write'],
  ledger: ['read'],
};

export function isKnownCall(verb: string, cls: string): boolean {
  const verbs = (VERB_CLASS as Record<string, readonly string[] | undefined>)[cls];
  return verbs !== undefined && verbs.includes(verb);
}

export const RULE_IDS = [
  'protect-tagged-destroy', 'floor-prod-immutable', 'scope-label-prefix', 'default-deny',
  'ceiling-dollar-deny', 'global-cap-exceeded', 'session-cap-exceeded', 'plan-not-allowed',
  'region-not-allowed', 'max-instances', 'rate-card-unavailable', 'egress-allowlist',
  'acl-tier-denied', 'tier-key-unavailable', 'last-copy-block', 'bond-required',
  'bond-insufficient', 'kill-switch-engaged',
  'allow-list', 'allow-worker-create', 'allow-worker-delete', 'allow-breadth-create',
  'allow-breadth-delete', 'allow-bucket-ops', 'allow-fetch', 'allow-policy-own',
  'allow-ledger-read', 'allow-instance-update',
  'policy-write-owner-only', 'policy-production-immutable', 'floor-registry-shared', 'target-unresolved',
  'playground-label-malformed', 'object-state-unknown', 'ttl-invalid', 'args-invalid',
] as const;

export function isAllowedRuleId(id: string): boolean {
  return (RULE_IDS as readonly string[]).includes(id) || id.startsWith('custom-');
}

const READ_VERBS: readonly Verb[] = ['list', 'read', 'fetch'];

export function tierFor(verb: Verb, cls: ResourceClass): Tier | null {
  if (cls === 'http' || cls === 'policy' || cls === 'ledger') return null;
  const reading = READ_VERBS.includes(verb);
  if (cls === 'instance' || cls === 'vpc') return reading ? 'observer' : 'deployer';
  if (cls === 'registry') return reading ? 'observer' : 'registry';
  if (cls === 'firewall_group') return 'network';
  return 'objstore';
}

/**
 * Session playground labels look like plumbline-s<sid>-<name>, where <sid> is exactly 8 lowercase hex characters.
 * Anything that starts with 'plumbline-s' but does not match is NOT a playground resource (plumbline-shared,
 * plumbline-ssh-infra, plumbline-sandbox-x) and the floor refuses to update or delete it (playground-label-malformed).
 * Documented in policy/floor.yaml; the single source of the regex is here.
 */
export const PLAYGROUND_LABEL_PREFIX = 'plumbline-s';
export const PLAYGROUND_LABEL_RE = /^plumbline-s[0-9a-f]{8}-[a-z][a-z0-9-]{0,39}$/;

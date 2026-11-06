// File: packages/vultr-adapter/test/mutators.typecheck.ts
import type { AllowDecision } from '@plumbline/policy-engine';
import type { Firewalls, Instances, Registries, Vpcs } from '../src/index.ts';

declare const instances: Instances;
declare const firewalls: Firewalls;
declare const vpcs: Vpcs;
declare const registries: Registries;
declare const allow: AllowDecision;
const ctx = { session_id: 's' };

// a plain object is not an AllowDecision
// @ts-expect-error
void instances.delete({ decision: 'ALLOW' }, ctx, 'i');
// @ts-expect-error
void instances.create({ decision: 'ALLOW', rule_id: 'x' }, ctx, { region: 'ewr', plan: 'p', label: 'l' });
// @ts-expect-error
void firewalls.delete({}, ctx, 'f');
// @ts-expect-error
void vpcs.delete(undefined, ctx, 'v');
// @ts-expect-error
void registries.delete('allow', ctx, 'r');
// omitting the decision altogether does not compile either
// @ts-expect-error
void instances.delete(ctx, 'i');

// the typed path compiles
void instances.delete(allow, ctx, 'i');

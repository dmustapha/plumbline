import type { AllowDecision, CallRequest } from '@plumbline/policy-engine';
import type { Firewalls, Instances, OwnerAction, OwnerAdmin, Registries, S3Store, Vpcs } from '../src/index.ts';

declare const instances: Instances;
declare const firewalls: Firewalls;
declare const vpcs: Vpcs;
declare const registries: Registries;
declare const admin: OwnerAdmin;
declare const s3: S3Store;
declare const allow: AllowDecision;
declare const owner: OwnerAction;
declare const req: CallRequest;
const ctx = { session_id: 's' };
const plain = { decision: 'ALLOW', rule_id: 'x' };
const plainOwner = { op: 'user.create', reason: 'r', id: 'oa-1', ts: 1 };

// a plain object is not an AllowDecision: every Vultr mutator rejects it at compile time
// @ts-expect-error
void instances.delete(plain, req);
// @ts-expect-error
void instances.create(plain, req);
// @ts-expect-error
void instances.update(plain, req, { firewall_group_id: 'f' });
// @ts-expect-error
void firewalls.create(plain, req);
// @ts-expect-error
void firewalls.addRule(plain, req, { port: '22', notes: 'n' });
// @ts-expect-error
void firewalls.delete({}, req);
// @ts-expect-error
void vpcs.create(plain, req);
// @ts-expect-error
void vpcs.delete(undefined, req);
// @ts-expect-error
void registries.create(plain, req);
// @ts-expect-error
void registries.delete('allow', req);
// omitting the decision altogether does not compile either
// @ts-expect-error
void instances.delete(req);
// an AllowDecision alone (no request to bind to) does not compile
// @ts-expect-error
void instances.delete(allow);
// the old (allow, ctx, id) shape is gone
// @ts-expect-error
void instances.delete(allow, ctx, 'i');

// S3 mutators
// @ts-expect-error
void s3.putObject(plain, req, '{}');
// @ts-expect-error
void s3.deleteObject(plain, req);
// @ts-expect-error
void s3.restoreVersion(plain, req);
// @ts-expect-error
void s3.ensureVersionedBucket(plain, ctx);
// @ts-expect-error
void s3.ensureVersionedBucket(ctx);
// an AllowDecision is not an OwnerAction, and a plain object is not either
// @ts-expect-error
void s3.ensureVersionedBucket(allow, ctx);
// @ts-expect-error
void s3.ensureVersionedBucket(plainOwner, ctx);

// OwnerAdmin: every mutator needs a minted OwnerAction first
// @ts-expect-error
void admin.createServiceUser('n', ['a']);
// @ts-expect-error
void admin.createServiceUser(plainOwner, 'n', ['a']);
// @ts-expect-error
void admin.issueKey('u', 'n', '2030-01-01');
// @ts-expect-error
void admin.issueKey(plainOwner, 'u', 'n', '2030-01-01');
// @ts-expect-error
void admin.ipAllow('u', '1.2.3.4');
// @ts-expect-error
void admin.ipAllow(allow, 'u', '1.2.3.4');
// @ts-expect-error
void admin.deleteUser('u');
// @ts-expect-error
void admin.deleteUser(plainOwner, 'u');
// @ts-expect-error
void admin.deleteObjectStorage('sub-1');
// @ts-expect-error
void admin.deleteObjectStorage(plainOwner, 'sub-1');

// the typed paths compile
void instances.delete(allow, req);
void s3.ensureVersionedBucket(owner, ctx);
void admin.createServiceUser(owner, 'n', ['a']);
void admin.issueKey(owner, 'u', 'n', '2030-01-01');
void admin.ipAllow(owner, 'u', '1.2.3.4');
void admin.deleteUser(owner, 'u');
void admin.deleteObjectStorage(owner, 'sub-1');

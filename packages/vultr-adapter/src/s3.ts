// File: packages/vultr-adapter/src/s3.ts
import {
  CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand,
  HeadBucketCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import type { AllowDecision, CallRequest, Verb } from '@plumbline/policy-engine';
import { guard, need } from './allow-guard.ts';
import type { SpendGate } from '@plumbline/ledger';
import type { Ctx } from './resources.ts';
import { consumeOwnerAction, type OwnerAction } from './owner-action.ts';

/** AG4-PRD-6: throws unless this session may touch this key. The broker passes rewind's assertSessionKey (the adapter cannot import rewind). */
export type KeyGuard = (sessionId: string, key: string) => void;

export interface S3Config {
  host: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
  keyGuard?: KeyGuard;
}

export interface VersionInfo {
  versionId: string;
  isLatest: boolean;
  size: number;
  lastModified: string;
}

export interface VersionListing {
  versions: VersionInfo[];
  deleteMarkers: { versionId: string; isLatest: boolean; lastModified: string }[];
  fetched_at: string;
}

/** Errors that mean "the key is not working" (health), as opposed to "the object is not there" (business answer). */
const BUSINESS_ERRORS = new Set(['NoSuchKey', 'NotFound', 'NoSuchVersion', 'BucketAlreadyOwnedByYou', 'BucketAlreadyExists']);

const MAX_LIST_PAGES = 10;

export interface S3Sender {
  send(command: unknown): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class S3Store {
  readonly bucket: string;
  readonly #client: S3Sender;
  readonly #gate: SpendGate;
  readonly #hasCreds: boolean;
  readonly #keyGuard: KeyGuard | undefined;
  #lastCallFailed = false;

  constructor(cfg: S3Config, gate: SpendGate, client?: S3Sender) {
    this.bucket = cfg.bucket;
    this.#gate = gate;
    this.#keyGuard = cfg.keyGuard;
    this.#hasCreds = Boolean(cfg.accessKey) && Boolean(cfg.secretKey) && Boolean(cfg.host);
    this.#client = client ?? new S3Client({
      endpoint: `https://${cfg.host}`,
      region: cfg.region ?? 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  toJSON(): string {
    return '[S3Store]';
  }

  /** AG4-ADP-7: credentials present AND the last real call did not fail on access/transport. */
  healthy(): boolean {
    return this.#hasCreds && !this.#lastCallFailed;
  }

  /** Cheap authenticated call used to recover health after a failure (fail-closed tiers make no other calls). */
  async probe(ctx: Ctx): Promise<boolean> {
    try {
      await this.#run(ctx, () => this.#client.send(new HeadBucketCommand({ Bucket: this.bucket })));
      return true;
    } catch {
      return false;
    }
  }

  /** AG4-ADP-6: every S3 call holds a receipt that is settled on success AND failure, and feeds health. */
  async #run<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    const c = this.#gate.charge('s3', 0, { session_id: ctx.session_id });
    if (!c.ok) throw new Error(`spend refused: ${c.reason}`);
    try {
      const out = await fn();
      this.#lastCallFailed = false;
      return out;
    } catch (e) {
      const name = (e as { name?: string }).name ?? '';
      if (!BUSINESS_ERRORS.has(name)) this.#lastCallFailed = true;
      throw e;
    } finally {
      c.receipt.settle(0);
    }
  }

  async ensureVersionedBucket(auth: OwnerAction, ctx: Ctx): Promise<void> {
    consumeOwnerAction(auth, 'bucket.ensure');
    await this.#run(ctx, async () => {
      try {
        await this.#client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (e) {
        const name = (e as { name?: string }).name ?? '';
        if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(name)) throw e;
      }
      await this.#client.send(new PutBucketVersioningCommand({ Bucket: this.bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    });
  }

  /** The key is read from the ALLOWed request and must equal its target id, so the policy judged the object we touch. */
  #objectKey(allow: AllowDecision, req: CallRequest, verb: Verb): { ctx: Ctx; key: string } {
    const key = need(req.params.key, 'key');
    if (req.target?.id !== key) throw new Error('KEY_TARGET_MISMATCH: params.key must equal target.id');
    const ctx = guard(allow, req, verb, 'bucket_object');
    this.#keyGuard?.(ctx.session_id, key);
    return { ctx, key };
  }

  async putObject(allow: AllowDecision, req: CallRequest, body: string): Promise<string> {
    const { ctx, key } = this.#objectKey(allow, req, 'put');
    const r = await this.#run(ctx, () => this.#client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json' })));
    return r.VersionId ?? '';
  }

  async deleteObject(allow: AllowDecision, req: CallRequest): Promise<string> {
    const { ctx, key } = this.#objectKey(allow, req, 'delete');
    const r = await this.#run(ctx, () => this.#client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })));
    return r.VersionId ?? '';
  }

  async restoreVersion(allow: AllowDecision, req: CallRequest): Promise<string> {
    const { ctx, key } = this.#objectKey(allow, req, 'restore');
    const versionId = need(req.params.version_id, 'version_id');
    const source = `${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(versionId)}`;
    const r = await this.#run(ctx, () => this.#client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: key, CopySource: source })));
    return r.VersionId ?? '';
  }

  /**
   * Straight from S3: the independent proof panel and the last-copy classification read this, never the broker's tags.
   * A truncated listing that does not complete inside MAX_LIST_PAGES is an error, never a short count (unknown state fails closed).
   */
  async listVersions(ctx: Ctx, key: string): Promise<VersionListing> {
    this.#keyGuard?.(ctx.session_id, key);
    const versions: VersionInfo[] = [];
    const deleteMarkers: VersionListing['deleteMarkers'] = [];
    let page: { keyMarker?: string; versionIdMarker?: string } = {};
    for (let i = 0; i < MAX_LIST_PAGES; i += 1) {
      const r = await this.#run(ctx, () => this.#client.send(new ListObjectVersionsCommand({
        Bucket: this.bucket, Prefix: key, KeyMarker: page.keyMarker, VersionIdMarker: page.versionIdMarker,
      })));
      for (const v of r.Versions ?? []) if (v.Key === key) versions.push({ versionId: v.VersionId ?? '', isLatest: Boolean(v.IsLatest), size: v.Size ?? 0, lastModified: v.LastModified?.toISOString() ?? '' });
      for (const m of r.DeleteMarkers ?? []) if (m.Key === key) deleteMarkers.push({ versionId: m.VersionId ?? '', isLatest: Boolean(m.IsLatest), lastModified: m.LastModified?.toISOString() ?? '' });
      if (!r.IsTruncated) return { versions, deleteMarkers, fetched_at: new Date().toISOString() };
      page = { keyMarker: r.NextKeyMarker, versionIdMarker: r.NextVersionIdMarker };
    }
    throw new Error('LISTING_INCOMPLETE: version listing did not finish, object state unknown');
  }

  async getObject(ctx: Ctx, key: string): Promise<string> {
    this.#keyGuard?.(ctx.session_id, key);
    const r = await this.#run(ctx, () => this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })));
    return (await r.Body?.transformToString()) ?? '';
  }
}

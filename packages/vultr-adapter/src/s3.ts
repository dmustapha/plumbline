// File: packages/vultr-adapter/src/s3.ts
import {
  CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand,
  PutBucketVersioningCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { assertAllow, type AllowDecision, type Verb } from '@plumbline/policy-engine';
import type { SpendGate } from '@plumbline/ledger';
import type { Ctx } from './resources.ts';

export interface S3Config {
  host: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
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

export class S3Store {
  readonly bucket: string;
  readonly #client: S3Client;
  readonly #gate: SpendGate;

  constructor(cfg: S3Config, gate: SpendGate) {
    this.bucket = cfg.bucket;
    this.#gate = gate;
    this.#client = new S3Client({
      endpoint: `https://${cfg.host}`,
      region: cfg.region ?? 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  toJSON(): string {
    return '[S3Store]';
  }

  #pass(ctx: Ctx): void {
    const c = this.#gate.charge('s3', 0, { session_id: ctx.session_id });
    if (!c.ok) throw new Error(`spend refused: ${c.reason}`);
  }

  #guard(allow: AllowDecision, verb: Verb): void {
    assertAllow(allow);
    if (allow.class !== 'bucket_object' || allow.verb !== verb) throw new Error('ALLOW_MISMATCH');
  }

  async ensureVersionedBucket(ctx: Ctx): Promise<void> {
    this.#pass(ctx);
    try {
      await this.#client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (e) {
      const name = (e as { name?: string }).name ?? '';
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(name)) throw e;
    }
    await this.#client.send(new PutBucketVersioningCommand({ Bucket: this.bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  }

  async putObject(allow: AllowDecision, ctx: Ctx, key: string, body: string): Promise<string> {
    this.#guard(allow, 'put');
    this.#pass(ctx);
    const r = await this.#client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json' }));
    return r.VersionId ?? '';
  }

  async deleteObject(allow: AllowDecision, ctx: Ctx, key: string): Promise<string> {
    this.#guard(allow, 'delete');
    this.#pass(ctx);
    const r = await this.#client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.VersionId ?? '';
  }

  async restoreVersion(allow: AllowDecision, ctx: Ctx, key: string, versionId: string): Promise<string> {
    this.#guard(allow, 'restore');
    this.#pass(ctx);
    const source = `${this.bucket}/${encodeURIComponent(key)}?versionId=${encodeURIComponent(versionId)}`;
    const r = await this.#client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: key, CopySource: source }));
    return r.VersionId ?? '';
  }

  /** Straight from S3: the independent proof panel and the last-copy classification read this, never the broker's tags. */
  async listVersions(ctx: Ctx, key: string): Promise<VersionListing> {
    this.#pass(ctx);
    const r = await this.#client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key }));
    return {
      versions: (r.Versions ?? []).filter((v) => v.Key === key).map((v) => ({
        versionId: v.VersionId ?? '', isLatest: Boolean(v.IsLatest), size: v.Size ?? 0, lastModified: v.LastModified?.toISOString() ?? '',
      })),
      deleteMarkers: (r.DeleteMarkers ?? []).filter((m) => m.Key === key).map((m) => ({
        versionId: m.VersionId ?? '', isLatest: Boolean(m.IsLatest), lastModified: m.LastModified?.toISOString() ?? '',
      })),
      fetched_at: new Date().toISOString(),
    };
  }

  async getObject(ctx: Ctx, key: string): Promise<string> {
    this.#pass(ctx);
    const r = await this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return (await r.Body?.transformToString()) ?? '';
  }
}

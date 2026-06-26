import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ObjectStore, ObjectStoreGetResult } from "@rag/core";

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (MinIO, Railway, GCS S3-mode). */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Path-style addressing — required by most non-AWS S3-compatible stores. */
  forcePathStyle?: boolean;
  /** Optional prefix prepended to every object key. */
  keyPrefix?: string;
}

/**
 * An {@link ObjectStore} backed by any S3-compatible service. Used to persist
 * original document bytes so cited documents can be downloaded later.
 *
 * Keys are LOGICAL: the configured `keyPrefix` is applied transparently inside
 * this class, so callers pass and read back the same logical key regardless of
 * prefix changes.
 */
export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly keyPrefix: string;

  constructor(opts: S3ObjectStoreOptions) {
    this.bucket = opts.bucket;
    this.keyPrefix = opts.keyPrefix ?? "";
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? true,
      // When explicit static credentials are absent, fall back to the SDK's
      // default credential chain (env, instance profile, etc.).
      credentials:
        opts.accessKeyId && opts.secretAccessKey
          ? {
              accessKeyId: opts.accessKeyId,
              secretAccessKey: opts.secretAccessKey,
            }
          : undefined,
    });
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<ObjectStoreGetResult> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
    if (!res.Body) {
      throw new Error(`object-store: empty body for key ${key}`);
    }
    // In the Node runtime the SDK's streaming body is a Node Readable.
    return {
      body: res.Body as unknown as Readable,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }),
    );
  }
}

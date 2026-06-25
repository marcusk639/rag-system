import { createHash } from "node:crypto";
import type { Config, ObjectStore } from "@rag/core";
import { ValidationError } from "@rag/core";
import { S3ObjectStore } from "./s3-object-store.js";

/**
 * Build the configured object store, or `null` when storage is disabled
 * (`provider: "none"`). A `null` store means originals are not persisted — the
 * ingestion pipeline skips the upload and the download route returns 404.
 *
 * Adding a new backend:
 *   1. Implement `ObjectStore` in a new file under storage/
 *   2. Add a case here
 *   3. Add its enum value to Config.objectStore.provider in @rag/core
 */
export function createObjectStore(
  cfg: Config["objectStore"],
): ObjectStore | null {
  if (cfg.provider === "none") return null;
  if (!cfg.bucket) {
    throw new ValidationError(
      "OBJECT_STORE_BUCKET is required when OBJECT_STORE_PROVIDER=s3",
    );
  }
  return new S3ObjectStore({
    bucket: cfg.bucket,
    region: cfg.region,
    endpoint: cfg.endpoint,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    forcePathStyle: cfg.forcePathStyle,
    keyPrefix: cfg.keyPrefix,
  });
}

/**
 * Deterministic LOGICAL storage key for a document's original bytes. Keyed by
 * `(sourceId, externalId)` so re-ingesting the same file overwrites the same
 * object (idempotent). The externalId is hashed because it can contain
 * characters that are awkward in object keys (e.g. the SharePoint `drive:item`
 * separator).
 */
export function documentStorageKey(
  sourceId: string,
  externalId: string,
): string {
  const hash = createHash("sha256").update(externalId).digest("hex");
  return `sources/${sourceId}/${hash}`;
}

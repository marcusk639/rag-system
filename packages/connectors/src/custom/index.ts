import type { Readable } from "node:stream";
import type { Logger } from "pino";
import {
  type Connector,
  type ConnectorListOptions,
  type ConnectorListResult,
  type ObjectStore,
  type SourceDocument,
  ValidationError,
} from "@rag/core";

/**
 * A file staged for ingestion via the browser upload path. Storage-agnostic:
 * the original bytes live in the object store under `storageKey`; this record
 * is the metadata the API persisted. `@rag/connectors` stays free of any
 * database dependency — the worker supplies an {@link UploadStagingStore}
 * implementation backed by `@rag/db`.
 */
export interface StagedUpload {
  /** Stable id; becomes the ingested document's `externalId`. */
  externalId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Object-store key the original bytes were written under. */
  storageKey: string;
  /** ISO timestamp the file was uploaded (used as the document modifiedAt). */
  uploadedAt: string;
}

/**
 * Port the worker implements (backed by the `pending_uploads` table). Keeps the
 * connector decoupled from the database and trivially unit-testable with a fake.
 */
export interface UploadStagingStore {
  /**
   * Atomically claim up to `limit` pending uploads for the source (oldest
   * first), marking them consumed so a later sync does not re-ingest them.
   */
  claim(sourceId: string, limit: number): Promise<StagedUpload[]>;
  /** Fetch a single staged upload by external id (retry/reprocess). */
  get(sourceId: string, externalId: string): Promise<StagedUpload | null>;
}

/** Default page size when the caller does not cap `maxItems`. */
const DEFAULT_PAGE_SIZE = 50;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Ingests browser-uploaded files staged by `POST /sources/:id/documents`.
 *
 * Unlike the external-system connectors (SharePoint, Drive, …), the "source"
 * here is our own staging area: a `custom` source's pending uploads. `list()`
 * claims a batch, reads each file's bytes from the object store, and yields
 * SourceDocuments for the normal parse → chunk → embed pipeline. There are no
 * deltas and no server cursor — claiming consumes rows, so successive calls
 * naturally drain the queue.
 *
 * Constructed directly by the worker (NOT via `createConnector`, which rejects
 * the `custom` kind) so it can be handed the staging store + object store.
 */
export class CustomConnector implements Connector {
  readonly kind = "custom";

  constructor(
    private readonly sourceId: string,
    private readonly store: UploadStagingStore,
    private readonly objectStore: ObjectStore | null,
    private readonly logger: Logger,
  ) {}

  async validate(): Promise<void> {
    // Uploaded originals are stored so cited documents can be downloaded; an
    // upload source cannot function without an object store. Fail loud on the
    // first job rather than silently dropping every uploaded file.
    if (!this.objectStore) {
      throw new ValidationError(
        "custom (upload) source requires an object store; none is configured",
      );
    }
  }

  async list(options?: ConnectorListOptions): Promise<ConnectorListResult> {
    const limit = options?.maxItems ?? DEFAULT_PAGE_SIZE;
    const claimed = await this.store.claim(this.sourceId, limit);
    const documents = await Promise.all(
      claimed.map((upload) => this.toDocument(upload)),
    );
    this.logger.info(
      { sourceId: this.sourceId, claimed: claimed.length },
      "custom connector claimed staged uploads",
    );
    // A short page means the queue is drained. Returning done=false on an exact
    // full page costs at most one extra empty list() call — harmless.
    return { documents, nextCursor: null, done: claimed.length < limit };
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    const upload = await this.store.get(this.sourceId, externalId);
    if (!upload) {
      throw new ValidationError(
        `no staged upload ${externalId} for source ${this.sourceId}`,
      );
    }
    return this.toDocument(upload);
  }

  private async toDocument(upload: StagedUpload): Promise<SourceDocument> {
    if (!this.objectStore) {
      // Unreachable: `validate()` runs first and throws. Keeps the type checker
      // honest without a non-null assertion.
      throw new ValidationError("object store not configured");
    }
    const object = await this.objectStore.get(upload.storageKey);
    const content = await streamToBuffer(object.body);
    return {
      externalId: upload.externalId,
      title: upload.filename,
      modifiedAt: upload.uploadedAt,
      mimeType: upload.mimeType,
      content,
      metadata: {
        title: upload.filename,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
      },
    };
  }
}

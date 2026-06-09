import type { Logger } from "pino";
import type { drive_v3 } from "googleapis";
import {
  type Connector,
  type ConnectorListOptions,
  type ConnectorListResult,
  type SourceDocument,
  ValidationError,
} from "@rag/core";
import { mapApiError } from "../util/errors.js";
import { makeCursorCodec } from "../util/cursor.js";
import { paginate, type ConnectorPage } from "../util/paginate.js";
import { createDriveClient, type GoogleCredentials } from "./client.js";
import { GDriveConfigSchema, type GDriveConfig } from "./config.js";

/**
 * Drive cursor mirrors the two-phase nature of the changes API:
 *   - `pageToken` is the next-page token for an in-flight `changes.list` call
 *     (or the bootstrap initial pageToken when no scan is active).
 *   - `mode` is "initial" while we paginate a `files.list` to seed the index,
 *     then flips to "delta" once we've called `getStartPageToken`.
 *
 * For "initial" mode we additionally store the next files.list pageToken in
 * `pageToken`. `startPageToken` is captured at the very start so we can begin
 * delta mode at the right offset once initial completes.
 */
interface GDriveCursor {
  mode: "initial" | "delta";
  pageToken: string | null;
  /** Captured at initial-sync start; becomes the delta token once initial completes. */
  startPageToken: string | null;
}

const cursorCodec = makeCursorCodec<GDriveCursor>("gdrive", (parsed) => {
  const p = parsed as Partial<GDriveCursor>;
  if (p.mode !== "initial" && p.mode !== "delta") {
    throw new Error(`invalid mode: ${String(p.mode)}`);
  }
  return {
    mode: p.mode,
    pageToken: p.pageToken ?? null,
    startPageToken: p.startPageToken ?? null,
  };
});

/** Workspace native MIME types we know how to export. */
const WORKSPACE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: "pptx",
  },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,size,webViewLink,parents,trashed,md5Checksum,owners(displayName,emailAddress)";

export class GDriveConnector implements Connector {
  readonly kind = "gdrive";

  private readonly config: GDriveConfig;
  private readonly drive: drive_v3.Drive;
  private readonly logger: Logger;

  constructor(
    rawConfig: unknown,
    credentials: GoogleCredentials,
    logger: Logger,
  ) {
    const parsed = GDriveConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ValidationError(
        `invalid GDrive config: ${parsed.error.message}`,
        parsed.error,
      );
    }
    this.config = parsed.data;
    this.drive = createDriveClient(credentials, this.config.impersonateUser);
    this.logger = logger.child({ connector: "gdrive" });
  }

  async validate(): Promise<void> {
    try {
      await this.drive.about.get({ fields: "user" });
    } catch (err) {
      mapApiError(err, "gdrive validate");
    }
  }

  async list(options: ConnectorListOptions = {}): Promise<ConnectorListResult> {
    return paginate<GDriveCursor>({
      maxItems: options.maxItems ?? 50,
      cursor: options.cursor
        ? cursorCodec.decode(options.cursor)
        : await this.bootstrapCursor(),
      encode: cursorCodec.encode,
      fetchPage: (cursor, remaining) => this.fetchPage(cursor, remaining),
    });
  }

  private fetchPage(
    cursor: GDriveCursor,
    remaining: number,
  ): Promise<ConnectorPage<GDriveCursor>> {
    return cursor.mode === "initial"
      ? this.fetchInitialPage(cursor, remaining)
      : this.fetchDeltaPage(cursor, remaining);
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    let file: drive_v3.Schema$File;
    try {
      const res = await this.drive.files.get({
        fileId: externalId,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      file = res.data;
    } catch (err) {
      mapApiError(err, `gdrive fetch ${externalId}`);
    }
    const doc = await this.materialize(file);
    if (!doc) {
      throw new ValidationError(
        `gdrive item ${externalId} cannot be materialized (folder, trashed, or unsupported)`,
      );
    }
    return doc;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async bootstrapCursor(): Promise<GDriveCursor> {
    // Capture start page token BEFORE we begin scanning, so anything that
    // changes during initial sync gets picked up by the first delta call.
    let startPageToken: string | null = null;
    try {
      const res = await this.drive.changes.getStartPageToken({
        supportsAllDrives: true,
      });
      startPageToken = res.data.startPageToken ?? null;
    } catch (err) {
      mapApiError(err, "gdrive getStartPageToken");
    }
    return { mode: "initial", pageToken: null, startPageToken };
  }

  /**
   * One `files.list` page of the initial scan. Never reports `done` — when the
   * scan completes it flips the cursor to delta mode, and `paginate` continues
   * draining the change feed (which owns the terminal `done`).
   */
  private async fetchInitialPage(
    cursor: GDriveCursor,
    remaining: number,
  ): Promise<ConnectorPage<GDriveCursor>> {
    let res: { data: drive_v3.Schema$FileList };
    try {
      res = await this.drive.files.list({
        q: this.buildListQuery(),
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: Math.min(100, Math.max(10, remaining)),
        pageToken: cursor.pageToken ?? undefined,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
    } catch (err) {
      mapApiError(err, "gdrive files.list");
    }

    const documents: SourceDocument[] = [];
    for (const file of res.data.files ?? []) {
      if (documents.length >= remaining) break;
      const doc = await this.materialize(file);
      if (doc) documents.push(doc);
    }

    const next = res.data.nextPageToken ?? null;
    if (!next) {
      // Initial scan complete; flip to delta mode using the token we captured
      // at the very beginning of the sync.
      return {
        documents,
        cursor: {
          mode: "delta",
          pageToken: cursor.startPageToken,
          startPageToken: cursor.startPageToken,
        },
        done: false,
      };
    }
    return {
      documents,
      cursor: { ...cursor, pageToken: next },
      done: false,
    };
  }

  /** One `changes.list` page of delta sync. `done` when the feed has drained. */
  private async fetchDeltaPage(
    cursor: GDriveCursor,
    remaining: number,
  ): Promise<ConnectorPage<GDriveCursor>> {
    if (!cursor.pageToken) {
      // Should never happen, but guard anyway: reseed an initial scan.
      this.logger.warn("gdrive delta missing pageToken; reseeding");
      const fresh = await this.bootstrapCursor();
      return { documents: [], cursor: fresh, done: false };
    }

    let res: { data: drive_v3.Schema$ChangeList };
    try {
      res = await this.drive.changes.list({
        pageToken: cursor.pageToken,
        fields: `nextPageToken, newStartPageToken, changes(removed,fileId,file(${FILE_FIELDS}))`,
        pageSize: Math.min(100, Math.max(10, remaining)),
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        includeRemoved: false,
      });
    } catch (err) {
      mapApiError(err, "gdrive changes.list");
    }

    const documents: SourceDocument[] = [];
    for (const change of res.data.changes ?? []) {
      if (documents.length >= remaining) break;
      if (change.removed) continue;
      if (!change.file) continue;
      const doc = await this.materialize(change.file);
      if (doc) documents.push(doc);
    }

    if (res.data.nextPageToken) {
      return {
        documents,
        cursor: { ...cursor, pageToken: res.data.nextPageToken },
        done: false,
      };
    }
    // No nextPageToken — change feed drained for now. Advance to the new start
    // token when Drive supplies one; otherwise keep the (drained) token.
    if (res.data.newStartPageToken) {
      return {
        documents,
        cursor: {
          mode: "delta",
          pageToken: res.data.newStartPageToken,
          startPageToken: res.data.newStartPageToken,
        },
        done: true,
      };
    }
    return { documents, cursor: { ...cursor }, done: true };
  }

  private buildListQuery(): string {
    const clauses: string[] = ["trashed = false"];
    if (this.config.folderId) {
      // Restrict to the folder's transitive contents via parents. For
      // descendant matching across subfolders we rely on the chosen folder
      // being a "shortcut" or top-level — Drive does not provide a recursive
      // operator. Most ingestion setups point at a single library root, which
      // works fine; nested traversal can be added later if needed.
      clauses.push(`'${this.config.folderId.replace(/'/g, "\\'")}' in parents`);
    }
    if (this.config.mimeTypes && this.config.mimeTypes.length > 0) {
      const ors = this.config.mimeTypes
        .map((m) => `mimeType = '${m.replace(/'/g, "\\'")}'`)
        .join(" or ");
      clauses.push(`(${ors})`);
    }
    if (this.config.query) clauses.push(`(${this.config.query})`);
    return clauses.join(" and ");
  }

  private async materialize(
    file: drive_v3.Schema$File,
  ): Promise<SourceDocument | null> {
    if (!file.id) return null;
    if (file.trashed) return null;
    if (file.mimeType === "application/vnd.google-apps.folder") return null;
    if (file.mimeType === "application/vnd.google-apps.shortcut") return null;

    const sizeBytes =
      typeof file.size === "string" ? Number(file.size) : undefined;
    if (
      typeof sizeBytes === "number" &&
      Number.isFinite(sizeBytes) &&
      sizeBytes > this.config.maxFileBytes
    ) {
      this.logger.warn(
        { id: file.id, size: sizeBytes, max: this.config.maxFileBytes },
        "gdrive file exceeds maxFileBytes, skipping",
      );
      return null;
    }

    const { bytes, mimeType, title } = await this.downloadContent(file);

    return {
      externalId: file.id,
      title,
      modifiedAt: file.modifiedTime ?? new Date().toISOString(),
      mimeType,
      content: bytes,
      metadata: {
        title,
        url: file.webViewLink ?? undefined,
        mimeType,
        sizeBytes:
          typeof sizeBytes === "number" && Number.isFinite(sizeBytes)
            ? sizeBytes
            : bytes.length,
        createdAt: file.createdTime ?? undefined,
        modifiedAt: file.modifiedTime ?? undefined,
        author: file.owners?.[0]?.displayName ?? undefined,
        extra: {
          fileId: file.id,
          parents: file.parents,
          originalMimeType: file.mimeType,
          md5Checksum: file.md5Checksum,
        },
      },
    };
  }

  private async downloadContent(file: drive_v3.Schema$File): Promise<{
    bytes: Buffer;
    mimeType: string;
    title: string;
  }> {
    if (!file.id) {
      throw new ValidationError("gdrive file missing id");
    }
    const exportInfo = file.mimeType
      ? WORKSPACE_EXPORTS[file.mimeType]
      : undefined;
    try {
      if (exportInfo) {
        const res = await this.drive.files.export(
          { fileId: file.id, mimeType: exportInfo.mime },
          { responseType: "arraybuffer" },
        );
        const data = res.data as ArrayBuffer | Buffer;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const baseName = file.name ?? file.id;
        const title = baseName.endsWith(`.${exportInfo.ext}`)
          ? baseName
          : `${baseName}.${exportInfo.ext}`;
        return { bytes: buf, mimeType: exportInfo.mime, title };
      }
      const res = await this.drive.files.get(
        { fileId: file.id, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );
      const data = res.data as ArrayBuffer | Buffer;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      return {
        bytes: buf,
        mimeType: file.mimeType ?? "application/octet-stream",
        title: file.name ?? file.id,
      };
    } catch (err) {
      mapApiError(err, `gdrive download ${file.id}`);
    }
  }
}

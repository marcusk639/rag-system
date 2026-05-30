import type { Logger } from "pino";
import {
  type Connector,
  type ConnectorListOptions,
  type ConnectorListResult,
  type SourceDocument,
  ValidationError,
} from "@rag/core";
import { GraphClient, type GraphCredentials } from "./client.js";
import { SharePointConfigSchema, type SharePointConfig } from "./config.js";

interface DriveItem {
  id: string;
  name?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  deleted?: { state?: string };
  parentReference?: { driveId?: string; path?: string };
  createdBy?: { user?: { displayName?: string; email?: string } };
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
}

interface DeltaResponse {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface DriveSummary {
  id: string;
  name?: string;
  webUrl?: string;
  driveType?: string;
}

interface DrivesResponse {
  value: DriveSummary[];
}

/**
 * The SharePoint cursor is a JSON envelope so we can both round-robin across
 * multiple document libraries on one site AND honor the per-drive deltaLink.
 *
 * Shape:
 *   {
 *     "drives":   ["driveId1", "driveId2"],   // queue of drives still to walk
 *     "current":  { "driveId": "...", "next": "https://..." | null },
 *     "deltas":   { "driveId1": "deltaLink", ... }   // completed drives → resume token
 *   }
 *
 * On a delta sync we replay each drive's stored deltaLink.
 */
interface SharePointCursor {
  drives: string[];
  current: { driveId: string; next: string | null } | null;
  deltas: Record<string, string>;
}

function emptyCursor(): SharePointCursor {
  return { drives: [], current: null, deltas: {} };
}

function encodeCursor(cursor: SharePointCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

function decodeCursor(raw: string): SharePointCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64").toString("utf8"),
    ) as Partial<SharePointCursor>;
    return {
      drives: Array.isArray(parsed.drives) ? parsed.drives : [],
      current: parsed.current ?? null,
      deltas: parsed.deltas ?? {},
    };
  } catch (err) {
    throw new ValidationError("invalid sharepoint cursor", err);
  }
}

export class SharePointConnector implements Connector {
  readonly kind = "sharepoint";

  private readonly config: SharePointConfig;
  private readonly graph: GraphClient;
  private readonly logger: Logger;

  constructor(
    rawConfig: unknown,
    credentials: GraphCredentials,
    logger: Logger,
  ) {
    const parsed = SharePointConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ValidationError(
        `invalid SharePoint config: ${parsed.error.message}`,
        parsed.error,
      );
    }
    this.config = parsed.data;
    this.graph = new GraphClient(credentials);
    this.logger = logger.child({ connector: "sharepoint" });
  }

  /** Cheap-ish auth probe: fetch the configured site. */
  async validate(): Promise<void> {
    await this.graph.getJson(
      `/sites/${encodeURIComponent(this.config.siteId)}`,
    );
  }

  async list(options: ConnectorListOptions = {}): Promise<ConnectorListResult> {
    const maxItems = Math.max(1, options.maxItems ?? 50);

    const cursor = options.cursor
      ? decodeCursor(options.cursor)
      : await this.bootstrapCursor();

    const documents: SourceDocument[] = [];

    while (documents.length < maxItems) {
      // Pull the next drive off the queue when we don't have one in flight.
      if (!cursor.current) {
        const nextDriveId = cursor.drives.shift();
        if (!nextDriveId) break; // nothing left to walk this call

        const resume = cursor.deltas[nextDriveId];
        cursor.current = {
          driveId: nextDriveId,
          next: resume ?? null,
        };
      }

      const { driveId, next } = cursor.current;
      const url = next ?? this.initialDeltaUrl(driveId);
      const page = await this.graph.getJson<DeltaResponse>(url);

      for (const item of page.value) {
        if (documents.length >= maxItems) break;
        const doc = await this.toSourceDocument(driveId, item);
        if (doc) documents.push(doc);
      }

      if (page["@odata.nextLink"]) {
        cursor.current = { driveId, next: page["@odata.nextLink"] };
        // Loop again — same drive, next page.
        continue;
      }

      if (page["@odata.deltaLink"]) {
        cursor.deltas[driveId] = page["@odata.deltaLink"];
      }
      cursor.current = null; // this drive is done for now
    }

    const done = cursor.current === null && cursor.drives.length === 0;
    return {
      documents,
      nextCursor: encodeCursor(cursor),
      done,
    };
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    // externalId encodes the drive + item: `${driveId}:${itemId}`.
    const sep = externalId.indexOf(":");
    if (sep < 0) {
      throw new ValidationError(
        `invalid sharepoint externalId (expected "<driveId>:<itemId>"): ${externalId}`,
      );
    }
    const driveId = externalId.slice(0, sep);
    const itemId = externalId.slice(sep + 1);

    const item = await this.graph.getJson<DriveItem>(
      `/drives/${driveId}/items/${itemId}`,
    );
    const doc = await this.toSourceDocument(driveId, item, {
      forceFetch: true,
    });
    if (!doc) {
      throw new ValidationError(
        `sharepoint item ${externalId} is not a downloadable file`,
      );
    }
    return doc;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Build the initial cursor. When `driveId` is configured we walk only that
   * drive. Otherwise we enumerate every document library on the site.
   */
  private async bootstrapCursor(): Promise<SharePointCursor> {
    const cursor = emptyCursor();
    if (this.config.driveId) {
      cursor.drives = [this.config.driveId];
      return cursor;
    }
    const res = await this.graph.getJson<DrivesResponse>(
      `/sites/${encodeURIComponent(this.config.siteId)}/drives`,
    );
    cursor.drives = res.value
      .filter(
        (d) => d.driveType === undefined || d.driveType === "documentLibrary",
      )
      .map((d) => d.id);
    this.logger.debug(
      { siteId: this.config.siteId, drives: cursor.drives.length },
      "sharepoint bootstrapped cursor",
    );
    return cursor;
  }

  /** Construct the Graph delta URL for the configured scope on a drive. */
  private initialDeltaUrl(driveId: string): string {
    const folderPath = this.config.folderPath?.trim();
    if (folderPath && this.config.driveId === driveId) {
      // Only honor folderPath when explicitly targeting that drive; otherwise
      // the folder may not exist in sibling document libraries.
      const path = folderPath
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/");
      return `/drives/${driveId}/root:/${path}:/delta`;
    }
    return `/drives/${driveId}/root/delta`;
  }

  /**
   * Convert a Graph driveItem into a SourceDocument, downloading content.
   * Returns null for entries we should skip (folders, deletes, oversize).
   */
  private async toSourceDocument(
    driveId: string,
    item: DriveItem,
    opts: { forceFetch?: boolean } = {},
  ): Promise<SourceDocument | null> {
    if (item.folder !== undefined) return null;
    if (item.deleted?.state) {
      this.logger.debug({ id: item.id }, "skipping deleted sharepoint item");
      return null;
    }
    if (!item.file) return null;
    if (
      typeof item.size === "number" &&
      item.size > this.config.maxFileBytes &&
      !opts.forceFetch
    ) {
      this.logger.warn(
        { id: item.id, size: item.size, max: this.config.maxFileBytes },
        "sharepoint item exceeds maxFileBytes, skipping",
      );
      return null;
    }

    const externalId = `${driveId}:${item.id}`;
    const { bytes, contentType } = await this.graph.getBytes(
      `/drives/${driveId}/items/${item.id}/content`,
    );

    const path = item.parentReference?.path
      ? `${item.parentReference.path.replace(/^\/drive\/root:?/, "")}/${item.name ?? ""}`.replace(
          /\/+/g,
          "/",
        )
      : (item.name ?? "");

    return {
      externalId,
      title: item.name ?? externalId,
      modifiedAt: item.lastModifiedDateTime ?? new Date().toISOString(),
      mimeType: item.file.mimeType ?? contentType,
      content: bytes,
      metadata: {
        title: item.name,
        url: item.webUrl,
        path: path || undefined,
        mimeType: item.file.mimeType ?? contentType,
        sizeBytes: typeof item.size === "number" ? item.size : bytes.length,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
        author:
          item.lastModifiedBy?.user?.displayName ??
          item.createdBy?.user?.displayName,
        extra: {
          siteId: this.config.siteId,
          driveId,
          itemId: item.id,
        },
      },
    };
  }
}

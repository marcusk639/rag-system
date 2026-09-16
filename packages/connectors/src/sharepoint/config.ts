import { z } from "zod";

/**
 * Per-source configuration for the SharePoint connector. Stored in the
 * `sources.config` JSONB column. The tenant/client/secret live in env vars
 * (shared across sources), not here.
 */
export const SharePointConfigSchema = z.object({
  /** Site to ingest. Use the Graph site id ("hostname,siteCollectionId,siteId"). */
  siteId: z.string().min(1),
  /**
   * Optional: restrict to a single document library / drive within the site.
   * When omitted the connector enumerates all document libraries on the site.
   */
  driveId: z.string().min(1).optional(),
  /**
   * Optional: restrict to a folder path inside the chosen drive (e.g. "Marketing/2024").
   * Only honored for initial (cursor-less) sync. Delta sync inherits the prior scope.
   */
  folderPath: z.string().min(1).optional(),
  /**
   * Cap on file size we will pull into memory. Files above this are skipped
   * (the worker logs and moves on). 50 MB default keeps a single doc bounded.
   */
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  /**
   * Folder-path fragments (case-insensitive substrings of the item's path,
   * e.g. "/clients/") whose files are never downloaded or indexed. Applied on
   * top of the built-in client-content denylist. A matching item that was
   * indexed before the exclusion was added is reported as a deletion. Keep
   * firm-specific folder names here, in source config, not in code.
   */
  excludePaths: z.array(z.string().min(1)).default([]),
});

export type SharePointConfig = z.infer<typeof SharePointConfigSchema>;

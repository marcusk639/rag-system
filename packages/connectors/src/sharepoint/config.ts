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
});

export type SharePointConfig = z.infer<typeof SharePointConfigSchema>;

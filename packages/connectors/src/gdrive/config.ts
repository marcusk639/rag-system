import { z } from "zod";

export const GDriveConfigSchema = z.object({
  /**
   * Restrict to a folder (and its descendants). If omitted, all files visible
   * to the credentials are enumerated. For service accounts, that means files
   * shared with the service account or accessible via domain-wide delegation.
   */
  folderId: z.string().min(1).optional(),
  /** Optional whitelist of MIME types to ingest. */
  mimeTypes: z.array(z.string().min(1)).optional(),
  /**
   * Optional Drive search query string applied during initial sync.
   * https://developers.google.com/drive/api/guides/search-files
   */
  query: z.string().min(1).optional(),
  /**
   * When operating as a service account with domain-wide delegation, the
   * email of the user to impersonate. Required for accessing user files
   * other than those explicitly shared with the service account.
   */
  impersonateUser: z.string().email().optional(),
  /** Per-file size cap (bytes). Default 50 MB. */
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
});

export type GDriveConfig = z.infer<typeof GDriveConfigSchema>;

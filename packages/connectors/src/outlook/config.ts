import { z } from "zod";

export const OutlookConfigSchema = z.object({
  /** Mailbox owner — UPN (user@tenant.com) or AAD object id. */
  userId: z.string().min(1),
  /** Optional: restrict to a specific mail folder (well-known name or id). */
  folderId: z.string().min(1).optional(),
  /** Optional OData $filter expression applied to the delta query. */
  filter: z.string().min(1).optional(),
  /** Whether to emit attachments as separate SourceDocuments. */
  includeAttachments: z.boolean().default(true),
  /** Per-message body cap (bytes). Default 10 MB. */
  maxBodyBytes: z
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /** Per-attachment cap (bytes). Default 25 MB. */
  maxAttachmentBytes: z
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
});

export type OutlookConfig = z.infer<typeof OutlookConfigSchema>;

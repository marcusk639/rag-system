import { z } from "zod";

export const GmailConfigSchema = z.object({
  /** Mailbox to read. "me" for OAuth user; a Workspace email for service accounts with DWD. */
  userId: z.string().min(1).default("me"),
  /** Restrict to specific labels (label IDs, e.g. ["INBOX"]). */
  labelIds: z.array(z.string().min(1)).optional(),
  /** Gmail search query (e.g. "is:unread newer_than:7d"). Applied to initial sync. */
  query: z.string().min(1).optional(),
  /** Whether to also emit attachments as separate SourceDocuments. */
  includeAttachments: z.boolean().default(true),
  /** When using service-account / domain-wide delegation, the subject to impersonate. */
  impersonateUser: z.string().email().optional(),
  /** Per-message body cap (bytes). Default 10 MB. */
  maxBodyBytes: z
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /** Per-attachment cap (bytes). Default 25 MB (Gmail's hard limit anyway). */
  maxAttachmentBytes: z
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
});

export type GmailConfig = z.infer<typeof GmailConfigSchema>;

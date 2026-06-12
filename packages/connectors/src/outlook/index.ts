import type { Logger } from "pino";
import {
  type Connector,
  type ConnectorListOptions,
  type ConnectorListResult,
  type DocumentMetadata,
  type SourceDocument,
  ValidationError,
} from "@rag/core";
import { htmlToText } from "../util/html.js";
import { makeCursorCodec } from "../util/cursor.js";
import { paginate, type ConnectorPage } from "../util/paginate.js";
import { GraphClient, type GraphCredentials } from "./client.js";
import { OutlookConfigSchema, type OutlookConfig } from "./config.js";

interface OutlookRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface OutlookMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: "text" | "html"; content?: string };
  from?: OutlookRecipient;
  sender?: OutlookRecipient;
  toRecipients?: OutlookRecipient[];
  ccRecipients?: OutlookRecipient[];
  bccRecipients?: OutlookRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  internetMessageId?: string;
  conversationId?: string;
  importance?: string;
  hasAttachments?: boolean;
  webLink?: string;
  isDraft?: boolean;
  "@removed"?: { reason?: string };
}

interface DeltaResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface OutlookAttachment {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  "@odata.type"?: string;
  contentBytes?: string;
}

/**
 * Outlook cursor is just the deltaLink (or nextLink within a page).
 *   { "link": "https://graph.microsoft.com/v1.0/users/.../messages/delta?..." }
 */
interface OutlookCursor {
  link: string | null;
}

const cursorCodec = makeCursorCodec<OutlookCursor>("outlook", (parsed) => ({
  link: (parsed as Partial<OutlookCursor>).link ?? null,
}));

export class OutlookConnector implements Connector {
  readonly kind = "outlook";

  private readonly config: OutlookConfig;
  private readonly graph: GraphClient;
  private readonly logger: Logger;

  constructor(
    rawConfig: unknown,
    credentials: GraphCredentials,
    logger: Logger,
  ) {
    const parsed = OutlookConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ValidationError(
        `invalid Outlook config: ${parsed.error.message}`,
        parsed.error,
      );
    }
    this.config = parsed.data;
    this.graph = new GraphClient(credentials);
    this.logger = logger.child({ connector: "outlook" });
  }

  async validate(): Promise<void> {
    await this.graph.getJson(
      `/users/${encodeURIComponent(this.config.userId)}`,
    );
  }

  async list(options: ConnectorListOptions = {}): Promise<ConnectorListResult> {
    return paginate<OutlookCursor>({
      maxItems: options.maxItems ?? 25,
      cursor: options.cursor
        ? cursorCodec.decode(options.cursor)
        : { link: this.initialDeltaUrl() },
      encode: cursorCodec.encode,
      fetchPage: (cursor, remaining) => this.fetchPage(cursor, remaining),
    });
  }

  /** Fetch one Graph delta page, advancing the cursor's deltaLink/nextLink. */
  private async fetchPage(
    cursor: OutlookCursor,
    remaining: number,
  ): Promise<ConnectorPage<OutlookCursor>> {
    const documents: SourceDocument[] = [];
    if (!cursor.link) {
      return { documents, cursor, done: true };
    }

    const page = await this.graph.getJson<DeltaResponse<OutlookMessage>>(
      cursor.link,
    );

    for (const msg of page.value) {
      if (documents.length >= remaining) break;
      if (msg["@removed"]) continue;
      if (msg.isDraft) continue;
      const doc = this.buildMessageDocument(msg);
      if (doc) documents.push(doc);
      if (this.config.includeAttachments && msg.hasAttachments) {
        for (const att of await this.fetchAttachments(msg.id)) {
          if (documents.length >= remaining) break;
          const adoc = this.buildAttachmentDocument(msg, att);
          if (adoc) documents.push(adoc);
        }
      }
    }

    if (page["@odata.nextLink"]) {
      return {
        documents,
        cursor: { link: page["@odata.nextLink"] },
        done: false,
      };
    }
    // No nextLink — end-of-feed. Save the deltaLink (or null) so the next sync
    // resumes from here, and report the feed as exhausted.
    return {
      documents,
      cursor: { link: page["@odata.deltaLink"] ?? null },
      done: true,
    };
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    const slash = externalId.indexOf("/");
    if (slash >= 0) {
      const messageId = externalId.slice(0, slash);
      const attachmentId = externalId.slice(slash + 1);
      const msg = await this.graph.getJson<OutlookMessage>(
        `/users/${encodeURIComponent(this.config.userId)}/messages/${encodeURIComponent(messageId)}`,
      );
      const att = await this.graph.getJson<OutlookAttachment>(
        `/users/${encodeURIComponent(this.config.userId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
      const doc = this.buildAttachmentDocument(msg, att);
      if (!doc) {
        throw new ValidationError(
          `outlook attachment ${externalId} not downloadable`,
        );
      }
      return doc;
    }
    const msg = await this.graph.getJson<OutlookMessage>(
      `/users/${encodeURIComponent(this.config.userId)}/messages/${encodeURIComponent(externalId)}`,
    );
    const doc = this.buildMessageDocument(msg);
    if (!doc) {
      throw new ValidationError(
        `outlook message ${externalId} not retrievable`,
      );
    }
    return doc;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private initialDeltaUrl(): string {
    const user = encodeURIComponent(this.config.userId);
    const scope = this.config.folderId
      ? `/mailFolders/${encodeURIComponent(this.config.folderId)}/messages/delta`
      : `/messages/delta`;
    const params = new URLSearchParams();
    if (this.config.filter) params.set("$filter", this.config.filter);
    params.set(
      "$select",
      [
        "id",
        "subject",
        "bodyPreview",
        "body",
        "from",
        "sender",
        "toRecipients",
        "ccRecipients",
        "bccRecipients",
        "receivedDateTime",
        "sentDateTime",
        "lastModifiedDateTime",
        "internetMessageId",
        "conversationId",
        "importance",
        "hasAttachments",
        "webLink",
        "isDraft",
      ].join(","),
    );
    const qs = params.toString();
    return `/users/${user}${scope}${qs ? `?${qs}` : ""}`;
  }

  private buildMessageDocument(msg: OutlookMessage): SourceDocument | null {
    if (!msg.id) return null;
    const subject = msg.subject ?? "(no subject)";
    const rawBody = msg.body?.content ?? "";
    const text =
      msg.body?.contentType === "html" ? htmlToText(rawBody) : rawBody.trim();
    const truncated =
      text.length > this.config.maxBodyBytes
        ? text.slice(0, this.config.maxBodyBytes)
        : text;

    const modifiedAt =
      msg.lastModifiedDateTime ??
      msg.receivedDateTime ??
      msg.sentDateTime ??
      new Date().toISOString();

    const from =
      msg.from?.emailAddress?.address ??
      msg.sender?.emailAddress?.address ??
      undefined;
    const to = (msg.toRecipients ?? [])
      .map((r) => r.emailAddress?.address)
      .filter((a): a is string => Boolean(a));
    const cc = (msg.ccRecipients ?? [])
      .map((r) => r.emailAddress?.address)
      .filter((a): a is string => Boolean(a));

    const metadata: DocumentMetadata = {
      title: subject,
      subject,
      from,
      to,
      mimeType: "text/plain",
      url: msg.webLink,
      modifiedAt,
      createdAt: msg.sentDateTime ?? msg.receivedDateTime ?? undefined,
      extra: {
        userId: this.config.userId,
        messageId: msg.id,
        conversationId: msg.conversationId,
        internetMessageId: msg.internetMessageId,
        importance: msg.importance,
        cc,
        hasAttachments: msg.hasAttachments ?? false,
      },
    };

    return {
      externalId: msg.id,
      title: subject,
      modifiedAt,
      mimeType: "text/plain",
      content: Buffer.from(truncated, "utf8"),
      metadata,
    };
  }

  private async fetchAttachments(
    messageId: string,
  ): Promise<OutlookAttachment[]> {
    const res = await this.graph.getJson<{ value: OutlookAttachment[] }>(
      `/users/${encodeURIComponent(this.config.userId)}/messages/${encodeURIComponent(messageId)}/attachments`,
    );
    return res.value ?? [];
  }

  private buildAttachmentDocument(
    msg: OutlookMessage,
    att: OutlookAttachment,
  ): SourceDocument | null {
    if (!msg.id || !att.id) return null;
    // Only file attachments include contentBytes. Item/reference attachments
    // can't be inlined; we skip them with a debug log.
    if (att["@odata.type"] !== "#microsoft.graph.fileAttachment") {
      this.logger.debug(
        { messageId: msg.id, attachmentId: att.id, type: att["@odata.type"] },
        "outlook attachment is not a file attachment, skipping",
      );
      return null;
    }
    if (
      typeof att.size === "number" &&
      att.size > this.config.maxAttachmentBytes
    ) {
      this.logger.warn(
        {
          messageId: msg.id,
          attachmentId: att.id,
          size: att.size,
          max: this.config.maxAttachmentBytes,
        },
        "outlook attachment exceeds maxAttachmentBytes, skipping",
      );
      return null;
    }
    if (!att.contentBytes) return null;

    const bytes = Buffer.from(att.contentBytes, "base64");
    const filename = att.name ?? `${att.id}.bin`;
    const modifiedAt = msg.lastModifiedDateTime ?? new Date().toISOString();
    const subject = msg.subject ?? "(no subject)";

    return {
      externalId: `${msg.id}/${att.id}`,
      title: filename,
      modifiedAt,
      mimeType: att.contentType ?? "application/octet-stream",
      content: bytes,
      metadata: {
        title: filename,
        mimeType: att.contentType ?? "application/octet-stream",
        sizeBytes: bytes.length,
        subject,
        from: msg.from?.emailAddress?.address,
        to: (msg.toRecipients ?? [])
          .map((r) => r.emailAddress?.address)
          .filter((a): a is string => Boolean(a)),
        modifiedAt,
        extra: {
          parentMessageId: msg.id,
          attachmentId: att.id,
          conversationId: msg.conversationId,
          isInline: att.isInline ?? false,
        },
      },
    };
  }
}

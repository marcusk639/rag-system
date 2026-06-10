import type { Logger } from "pino";
import type { gmail_v1 } from "googleapis";
import {
  type Connector,
  type ConnectorListOptions,
  type ConnectorListResult,
  type DocumentMetadata,
  type SourceDocument,
  ValidationError,
} from "@rag/core";
import { mapApiError } from "../util/errors.js";
import { htmlToText } from "../util/html.js";
import { makeCursorCodec } from "../util/cursor.js";
import { paginate, type ConnectorPage } from "../util/paginate.js";
import { createGmailClient, type GoogleCredentials } from "./client.js";
import { GmailConfigSchema, type GmailConfig } from "./config.js";
import { collectPart, headersToMap, parseAddressList, toIso } from "./parse.js";

/**
 * Cursor model:
 *
 *   "initial" mode walks `messages.list` with an optional `pageToken`. While
 *     paginating we also remember the largest historyId we've seen so we can
 *     pick up from there once initial completes.
 *
 *   "delta" mode walks `history.list` starting at `historyId`. Each page may
 *     advance historyId; when we've drained the history we stay on the latest
 *     value for the next poll.
 */
interface GmailCursor {
  mode: "initial" | "delta";
  pageToken: string | null;
  historyId: string | null;
}

function emptyCursor(): GmailCursor {
  return { mode: "initial", pageToken: null, historyId: null };
}

const cursorCodec = makeCursorCodec<GmailCursor>("gmail", (parsed) => {
  const p = parsed as Partial<GmailCursor>;
  if (p.mode !== "initial" && p.mode !== "delta") {
    throw new Error(`invalid mode: ${String(p.mode)}`);
  }
  return {
    mode: p.mode,
    pageToken: p.pageToken ?? null,
    historyId: p.historyId ?? null,
  };
});

export class GmailConnector implements Connector {
  readonly kind = "gmail";

  private readonly config: GmailConfig;
  private readonly gmail: gmail_v1.Gmail;
  private readonly logger: Logger;

  constructor(
    rawConfig: unknown,
    credentials: GoogleCredentials,
    logger: Logger,
  ) {
    const parsed = GmailConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ValidationError(
        `invalid Gmail config: ${parsed.error.message}`,
        parsed.error,
      );
    }
    this.config = parsed.data;
    this.gmail = createGmailClient(credentials, this.config.impersonateUser);
    this.logger = logger.child({ connector: "gmail" });
  }

  async validate(): Promise<void> {
    try {
      await this.gmail.users.getProfile({ userId: this.config.userId });
    } catch (err) {
      mapApiError(err, "gmail validate");
    }
  }

  async list(options: ConnectorListOptions = {}): Promise<ConnectorListResult> {
    return paginate<GmailCursor>({
      maxItems: options.maxItems ?? 25,
      cursor: options.cursor
        ? cursorCodec.decode(options.cursor)
        : emptyCursor(),
      encode: cursorCodec.encode,
      fetchPage: (cursor, remaining) => this.fetchPage(cursor, remaining),
    });
  }

  private fetchPage(
    cursor: GmailCursor,
    remaining: number,
  ): Promise<ConnectorPage<GmailCursor>> {
    return cursor.mode === "initial"
      ? this.fetchInitialPage(cursor, remaining)
      : this.fetchDeltaPage(cursor, remaining);
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    // For attachments: `${messageId}/${attachmentId}`.
    const slash = externalId.indexOf("/");
    if (slash >= 0) {
      const messageId = externalId.slice(0, slash);
      const attachmentId = externalId.slice(slash + 1);
      const messageMeta = await this.loadMessage(messageId);
      const attachments = this.extractAttachments(messageMeta);
      const target = attachments.find((a) => a.attachmentId === attachmentId);
      if (!target) {
        throw new ValidationError(
          `gmail attachment ${externalId} not found on message`,
        );
      }
      const doc = await this.buildAttachmentDocument(messageMeta, target);
      if (!doc) {
        throw new ValidationError(
          `gmail attachment ${externalId} could not be downloaded`,
        );
      }
      return doc;
    }
    const messageMeta = await this.loadMessage(externalId);
    return this.buildMessageDocument(messageMeta);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * One `messages.list` page of the initial scan. Never reports `done` — when
   * the scan completes it flips the cursor to delta mode, and `paginate`
   * continues draining the history feed (which owns the terminal `done`).
   */
  private async fetchInitialPage(
    cursor: GmailCursor,
    remaining: number,
  ): Promise<ConnectorPage<GmailCursor>> {
    let res: { data: gmail_v1.Schema$ListMessagesResponse };
    try {
      res = await this.gmail.users.messages.list({
        userId: this.config.userId,
        labelIds: this.config.labelIds,
        q: this.config.query,
        pageToken: cursor.pageToken ?? undefined,
        maxResults: Math.min(100, Math.max(10, remaining)),
      });
    } catch (err) {
      mapApiError(err, "gmail messages.list");
    }

    const documents: SourceDocument[] = [];
    let historyId = cursor.historyId;
    for (const stub of res.data.messages ?? []) {
      if (documents.length >= remaining) break;
      if (!stub.id) continue;
      const full = await this.loadMessage(stub.id);
      documents.push(this.buildMessageDocument(full));
      if (full.historyId) {
        // Track the highest historyId we encounter so delta sync resumes correctly.
        if (!historyId || BigInt(full.historyId) > BigInt(historyId)) {
          historyId = full.historyId;
        }
      }
      if (this.config.includeAttachments) {
        for (const att of this.extractAttachments(full)) {
          if (documents.length >= remaining) break;
          const adoc = await this.buildAttachmentDocument(full, att);
          if (adoc) documents.push(adoc);
        }
      }
    }

    const nextPageToken = res.data.nextPageToken ?? null;
    if (nextPageToken) {
      return {
        documents,
        cursor: { mode: "initial", pageToken: nextPageToken, historyId },
        done: false,
      };
    }

    // Initial scan complete; flip to delta mode. If we never observed a
    // historyId, fall back to the mailbox profile's.
    if (!historyId) {
      try {
        const profile = await this.gmail.users.getProfile({
          userId: this.config.userId,
        });
        historyId = profile.data.historyId ?? null;
      } catch (err) {
        mapApiError(err, "gmail getProfile");
      }
    }
    return {
      documents,
      cursor: { mode: "delta", pageToken: null, historyId },
      done: false,
    };
  }

  /** One `history.list` page of delta sync. `done` when the feed has drained. */
  private async fetchDeltaPage(
    cursor: GmailCursor,
    remaining: number,
  ): Promise<ConnectorPage<GmailCursor>> {
    if (!cursor.historyId) {
      this.logger.warn("gmail delta missing historyId; restarting initial");
      return {
        documents: [],
        cursor: { mode: "initial", pageToken: null, historyId: null },
        done: false,
      };
    }

    let res: { data: gmail_v1.Schema$ListHistoryResponse };
    try {
      res = await this.gmail.users.history.list({
        userId: this.config.userId,
        startHistoryId: cursor.historyId,
        labelId: this.config.labelIds?.[0],
        historyTypes: ["messageAdded", "labelAdded"],
        pageToken: cursor.pageToken ?? undefined,
        maxResults: Math.min(100, Math.max(10, remaining)),
      });
    } catch (err) {
      mapApiError(err, "gmail history.list");
    }

    const seenIds = new Set<string>();
    for (const entry of res.data.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        const id = added.message?.id;
        if (id) seenIds.add(id);
      }
      for (const lbl of entry.labelsAdded ?? []) {
        const id = lbl.message?.id;
        if (id) seenIds.add(id);
      }
    }

    const documents: SourceDocument[] = [];
    for (const id of seenIds) {
      if (documents.length >= remaining) break;
      let full: gmail_v1.Schema$Message;
      try {
        full = await this.loadMessage(id);
      } catch (err) {
        // Message may have been deleted between history page and now.
        this.logger.debug({ err, id }, "gmail message disappeared, skipping");
        continue;
      }
      documents.push(this.buildMessageDocument(full));
      if (this.config.includeAttachments) {
        for (const att of this.extractAttachments(full)) {
          if (documents.length >= remaining) break;
          const adoc = await this.buildAttachmentDocument(full, att);
          if (adoc) documents.push(adoc);
        }
      }
    }

    const historyId = res.data.historyId ?? cursor.historyId;
    const nextPageToken = res.data.nextPageToken ?? null;
    return {
      documents,
      cursor: { mode: "delta", pageToken: nextPageToken, historyId },
      done: nextPageToken === null,
    };
  }

  private async loadMessage(
    messageId: string,
  ): Promise<gmail_v1.Schema$Message> {
    try {
      const res = await this.gmail.users.messages.get({
        userId: this.config.userId,
        id: messageId,
        format: "full",
      });
      return res.data;
    } catch (err) {
      mapApiError(err, `gmail messages.get ${messageId}`);
    }
  }

  private buildMessageDocument(msg: gmail_v1.Schema$Message): SourceDocument {
    if (!msg.id) {
      throw new ValidationError("gmail message missing id");
    }
    const headers = headersToMap(msg.payload?.headers);
    const subject = headers.get("subject") ?? "(no subject)";
    const from = headers.get("from") ?? undefined;
    const to = parseAddressList(headers.get("to"));
    const cc = parseAddressList(headers.get("cc"));
    const dateHeader = headers.get("date");

    const bodyText = this.extractBodyText(msg.payload);
    const truncated =
      bodyText.length > this.config.maxBodyBytes
        ? bodyText.slice(0, this.config.maxBodyBytes)
        : bodyText;

    const modifiedAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : (toIso(dateHeader) ?? new Date().toISOString());

    const meta: DocumentMetadata = {
      title: subject,
      subject,
      from,
      to,
      mimeType: "text/plain",
      createdAt: modifiedAt,
      modifiedAt,
      extra: {
        messageId: msg.id,
        threadId: msg.threadId,
        labelIds: msg.labelIds,
        historyId: msg.historyId,
        cc,
        snippet: msg.snippet,
      },
    };

    return {
      externalId: msg.id,
      title: subject,
      modifiedAt,
      mimeType: "text/plain",
      content: Buffer.from(truncated, "utf8"),
      metadata: meta,
    };
  }

  /**
   * Walk the MIME tree depth-first, preferring text/plain over text/html.
   * HTML parts are converted to text as a fallback when no plain text exists.
   */
  private extractBodyText(
    part: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!part) return "";
    const plain = collectPart(part, "text/plain");
    if (plain) return plain;
    const html = collectPart(part, "text/html");
    return html ? htmlToText(html) : "";
  }

  private extractAttachments(msg: gmail_v1.Schema$Message): Array<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    if (!this.config.includeAttachments) return [];
    const acc: Array<{
      attachmentId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];
    const walk = (p?: gmail_v1.Schema$MessagePart): void => {
      if (!p) return;
      const id = p.body?.attachmentId;
      const filename = p.filename;
      if (id && filename) {
        acc.push({
          attachmentId: id,
          filename,
          mimeType: p.mimeType ?? "application/octet-stream",
          sizeBytes: p.body?.size ?? 0,
        });
      }
      for (const child of p.parts ?? []) walk(child);
    };
    walk(msg.payload);
    return acc;
  }

  private async buildAttachmentDocument(
    msg: gmail_v1.Schema$Message,
    att: {
      attachmentId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    },
  ): Promise<SourceDocument | null> {
    if (!msg.id) return null;
    if (att.sizeBytes > this.config.maxAttachmentBytes) {
      this.logger.warn(
        {
          messageId: msg.id,
          attachmentId: att.attachmentId,
          size: att.sizeBytes,
          max: this.config.maxAttachmentBytes,
        },
        "gmail attachment exceeds maxAttachmentBytes, skipping",
      );
      return null;
    }
    let data: string | undefined;
    try {
      const res = await this.gmail.users.messages.attachments.get({
        userId: this.config.userId,
        messageId: msg.id,
        id: att.attachmentId,
      });
      data = res.data.data ?? undefined;
    } catch (err) {
      mapApiError(err, `gmail attachments.get ${msg.id}/${att.attachmentId}`);
    }
    if (!data) return null;
    const bytes = Buffer.from(data, "base64url");

    const headers = headersToMap(msg.payload?.headers);
    const subject = headers.get("subject") ?? "(no subject)";
    const modifiedAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString();

    return {
      externalId: `${msg.id}/${att.attachmentId}`,
      title: att.filename,
      modifiedAt,
      mimeType: att.mimeType,
      content: bytes,
      metadata: {
        title: att.filename,
        mimeType: att.mimeType,
        sizeBytes: bytes.length,
        subject,
        from: headers.get("from") ?? undefined,
        to: parseAddressList(headers.get("to")),
        modifiedAt,
        extra: {
          parentMessageId: msg.id,
          attachmentId: att.attachmentId,
          threadId: msg.threadId,
          labelIds: msg.labelIds,
        },
      },
    };
  }
}

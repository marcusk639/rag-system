import { request } from "undici";
import type { ParsedDocument, Parser } from "@rag/core";
import { ParserError, ParsedDocumentSchema } from "@rag/core";

/**
 * Client for the Python parser sidecar. Wraps the HTTP boundary so the rest
 * of the system uses a clean `Parser` interface.
 */
export class HttpParserClient implements Parser {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 60_000,
    /**
     * Optional shared secret. When set, every request carries it in the
     * `X-Parser-Token` header so the sidecar can authenticate the caller.
     * Leave undefined for single-host dev where the parser is loopback-bound.
     */
    private readonly secret?: string,
  ) {}

  async parse(input: {
    content: Buffer;
    mimeType: string;
    filename: string;
  }): Promise<ParsedDocument> {
    const boundary = `----rag-${Date.now().toString(36)}`;
    const body = buildMultipart(boundary, input);

    const headers: Record<string, string> = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    };
    if (this.secret) {
      headers["x-parser-token"] = this.secret;
    }

    let response;
    try {
      response = await request(`${this.baseUrl}/parse`, {
        method: "POST",
        headers,
        body,
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
      });
    } catch (err) {
      // The message carries the failure *category* only — undici's own text
      // names the sidecar's internal host and port. The full error stays on
      // `cause`, where the logger and Sentry still see it.
      const code = (err as { code?: string }).code ?? "unknown";
      throw new ParserError(`Parser request failed (${code})`, err);
    }

    if (response.statusCode >= 400) {
      const text = await response.body.text();
      // The body is not content-free. The sidecar interpolates the underlying
      // library exception into its `detail` (services/parser-py/app/parsing.py
      // :203 and :207, tabular.py:39 and :73) and those exceptions can quote
      // the offending cell or line — so a 4xx *or* 5xx body may carry document
      // text.
      //
      // Why that matters for a `RagError` specifically: both transports used to
      // treat a RagError's `message` as text they may show a caller. They now
      // gate on `ECHOABLE_ERROR_CODES` (@rag/core), which excludes
      // PARSER_ERROR — so document text in this message would no longer reach
      // a client. Redacting here stays worthwhile as defence in depth: it also
      // keeps document text out of logs and Sentry, which the allow-list does
      // not govern. No route reaches a ParserError today (the parser client
      // is constructed only in apps/worker, and PARSER_ERROR's 502 mapping is
      // defensive), so this is keeping the contract true rather than closing a
      // live hole.
      //
      // What this does NOT do is keep the body out of the logs, and it is not
      // meant to: pino's serializer folds the cause chain back into the
      // serialized `message` via `messageWithCauses`, so the log line still
      // carries the body. That is where the detail belongs. The change moves it
      // off the `.message` property, which is what a transport would read.
      //
      // `cause` must therefore be an Error, not the raw string: the serializer
      // only walks a cause it considers error-like, so a string cause is
      // dropped from the log entirely instead of relocated there.
      //
      // The nearest in-repo principle is `RedactionFinding`
      // (packages/core/src/content-safety.ts:30-35), which carries `kind` +
      // `count` and never the matched value. That governs the finding object,
      // so applying it to a message is an extension of the idea, not a rule
      // this repo already states.
      throw new ParserError(
        `Parser returned ${response.statusCode}`,
        new Error(text.slice(0, 500)),
      );
    }

    const raw = await response.body.json();
    const result = ParsedDocumentSchema.safeParse(raw);
    if (!result.success) {
      throw new ParserError(
        `Parser sidecar returned a malformed response: ${result.error.message}`,
        result.error,
      );
    }
    const json = result.data;
    return {
      title: json.title,
      markdown: json.markdown,
      tables: json.tables,
      metadata: json.metadata,
    };
  }
}

/**
 * Build a minimal RFC 7578 multipart/form-data body. We avoid `form-data`
 * and `FormData` libs because they have inconsistent Node/undici support
 * for streaming buffers; a 50-line builder is more reliable here.
 */
/**
 * Strip CR/LF from any value we splice into multipart header lines.
 * Filenames and MIME types come from upstream connectors (SharePoint, Gmail,
 * etc.); a value containing `\r\n` would let an attacker smuggle additional
 * MIME parts into the body we send to the parser sidecar.
 */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\x00]/g, "");
}

function buildMultipart(
  boundary: string,
  input: { content: Buffer; mimeType: string; filename: string },
): Buffer {
  const parts: Buffer[] = [];
  const dashes = `--${boundary}`;
  const safeFilename = sanitizeHeader(input.filename);
  const safeMime = sanitizeHeader(input.mimeType);
  const fileSafeName = safeFilename.replace(/"/g, "_");

  parts.push(
    Buffer.from(
      `${dashes}\r\n` +
        `Content-Disposition: form-data; name="filename"\r\n\r\n` +
        `${safeFilename}\r\n`,
      "utf8",
    ),
  );
  parts.push(
    Buffer.from(
      `${dashes}\r\n` +
        `Content-Disposition: form-data; name="mime_type"\r\n\r\n` +
        `${safeMime}\r\n`,
      "utf8",
    ),
  );
  parts.push(
    Buffer.from(
      `${dashes}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileSafeName}"\r\n` +
        `Content-Type: ${safeMime || "application/octet-stream"}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(input.content);
  parts.push(Buffer.from(`\r\n${dashes}--\r\n`, "utf8"));

  return Buffer.concat(parts);
}

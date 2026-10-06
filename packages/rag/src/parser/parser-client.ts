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
      // The body is not content-free: a 4xx on a malformed document can echo
      // the document's own text back, and this message is logged through pino
      // and recorded in the ingestion audit trail's rejection reason. This
      // repo holds a redaction finding to "a category/description only, never
      // a raw identifying value lifted verbatim into logs" — a parse failure
      // is held to the same standard, so the status code identifies it and the
      // body travels on `cause` instead of being interpolated into a message
      // that gets copied onward.
      throw new ParserError(
        `Parser returned ${response.statusCode}`,
        text.slice(0, 500),
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

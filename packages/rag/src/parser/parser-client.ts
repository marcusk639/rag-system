import { request } from "undici";
import type { ParsedDocument, Parser } from "@rag/core";
import { ParserError } from "@rag/core";

/**
 * The parser's `metadata` is a free-form bag on the wire; the generated type is
 * only a compile-time claim. Validate it's at least a plain JSON object at this
 * system boundary (repo rule) so downstream code can trust the structural shape
 * — a primitive or array here would silently corrupt the merged document row.
 */
function asMetadataObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ParserError(
      `Parser returned non-object metadata: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Client for the Python parser sidecar. Wraps the HTTP boundary so the rest
 * of the system uses a clean `Parser` interface.
 */
export class HttpParserClient implements Parser {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 60_000,
  ) {}

  async parse(input: {
    content: Buffer;
    mimeType: string;
    filename: string;
  }): Promise<ParsedDocument> {
    const boundary = `----rag-${Date.now().toString(36)}`;
    const body = buildMultipart(boundary, input);

    let response;
    try {
      response = await request(`${this.baseUrl}/parse`, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
      });
    } catch (err) {
      throw new ParserError(
        `Parser request failed: ${(err as Error).message}`,
        err,
      );
    }

    if (response.statusCode >= 400) {
      const text = await response.body.text();
      throw new ParserError(
        `Parser returned ${response.statusCode}: ${text.slice(0, 500)}`,
      );
    }

    const json = (await response.body.json()) as ParsedDocument;
    return {
      title: json.title,
      markdown: json.markdown,
      tables: json.tables ?? [],
      metadata: asMetadataObject(json.metadata),
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
  // eslint-disable-next-line no-control-regex
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

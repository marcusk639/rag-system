import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();
vi.mock("undici", () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

// Imported after the mock is registered so the client picks up the stub.
const { HttpParserClient } = await import("./parser-client.js");

function okResponse() {
  return {
    statusCode: 200,
    body: {
      json: async () => ({
        title: "t",
        markdown: "# t",
        tables: [],
        metadata: {},
      }),
    },
  };
}

const input = {
  content: Buffer.from("hello"),
  mimeType: "text/plain",
  filename: "a.txt",
};

function sentHeaders(): Record<string, string> {
  const [, opts] = requestMock.mock.calls[0] as [
    string,
    { headers: Record<string, string> },
  ];
  return opts.headers;
}

describe("HttpParserClient shared-secret auth", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(okResponse());
  });

  it("omits X-Parser-Token when no secret is configured", async () => {
    const client = new HttpParserClient("http://parser:8000");
    await client.parse(input);
    expect(sentHeaders()["x-parser-token"]).toBeUndefined();
  });

  it("sends X-Parser-Token when a secret is configured", async () => {
    const client = new HttpParserClient("http://parser:8000", 60_000, "s3cr3t");
    await client.parse(input);
    expect(sentHeaders()["x-parser-token"]).toBe("s3cr3t");
  });

  it("still sends the multipart content-type alongside the token", async () => {
    const client = new HttpParserClient("http://parser:8000", 60_000, "s3cr3t");
    await client.parse(input);
    expect(sentHeaders()["content-type"]).toMatch(
      /^multipart\/form-data; boundary=/,
    );
  });
});

/**
 * The parser sidecar's error body is attacker-free but not content-free: a 4xx
 * on a malformed document can echo the document's own text back. Up to 500
 * chars of it went into `ParserError.message`, which the ingestion pipeline
 * logs through pino and records in the audit trail's rejection reason.
 *
 * This repo's own content-safety contract is explicit that a finding carries
 * "a category/description only, never a raw identifying value lifted verbatim
 * into logs". A parse failure is held to the same standard: the status code
 * identifies the failure, and the body stays in `cause`, where the logger and
 * Sentry can see it but it is never interpolated into a message that gets
 * copied onward.
 *
 * Note this is NOT a client-facing leak: the parser client is constructed only
 * in apps/worker, so a ParserError cannot reach an HTTP route or an MCP tool.
 * It is about what lands in the logs and the durable audit columns.
 */
describe("HttpParserClient error bodies stay out of the message", () => {
  const SENSITIVE =
    "Engagement letter for Jane Doe, SSN 123-45-6789, re: 2025 Form 1040";

  beforeEach(() => {
    requestMock.mockReset();
  });

  it("names the status code but not the response body", async () => {
    requestMock.mockResolvedValue({
      statusCode: 422,
      body: { text: async () => SENSITIVE },
    });
    const client = new HttpParserClient("http://parser:8000", 1000);

    const err = (await client
      .parse(input)
      .catch((e: unknown) => e)) as Error & { cause?: unknown };

    expect(err.message).toContain("422");
    expect(err.message).not.toContain("Jane Doe");
    expect(err.message).not.toContain("123-45-6789");
    expect(err.message).not.toContain("Form 1040");
  });

  it("keeps the body on cause so the failure is still diagnosable", async () => {
    requestMock.mockResolvedValue({
      statusCode: 500,
      body: { text: async () => SENSITIVE },
    });
    const client = new HttpParserClient("http://parser:8000", 1000);

    const err = (await client
      .parse(input)
      .catch((e: unknown) => e)) as Error & { cause?: unknown };

    expect(String(err.cause)).toContain("Jane Doe");
  });

  it("does not interpolate a transport error's message either", async () => {
    // undici's network errors name the host and port of the internal sidecar.
    requestMock.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:8000"),
    );
    const client = new HttpParserClient("http://parser:8000", 1000);

    const err = (await client
      .parse(input)
      .catch((e: unknown) => e)) as Error & { cause?: unknown };

    expect(err.message).not.toContain("10.0.0.5");
    expect((err.cause as Error).message).toContain("10.0.0.5");
  });

  it("keeps a schema failure's message value-free", async () => {
    // Not a fix -- a forward guard. zod names the offending *paths* and types,
    // not the received values, so this throw site was already safe and is left
    // as-is for diagnosability. The assertion keeps it that way.
    requestMock.mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ title: SENSITIVE }) },
    });
    const client = new HttpParserClient("http://parser:8000", 1000);

    const err = (await client
      .parse(input)
      .catch((e: unknown) => e)) as Error & { cause?: unknown };

    expect(err.message).not.toContain("Jane Doe");
    expect(err.cause).toBeDefined();
  });
});

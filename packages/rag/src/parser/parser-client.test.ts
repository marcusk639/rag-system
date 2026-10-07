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
 * The parser sidecar's error body is not content-free: the sidecar interpolates
 * the underlying library exception into its `detail` (parsing.py:203,207 and
 * tabular.py:39,73), and those can quote the offending cell or line, on a 5xx
 * as well as a 4xx. Up to 500 chars of it went into `ParserError.message`.
 *
 * `message` WAS the field both transports treated as showable (they now gate on `ECHOABLE_ERROR_CODES` in @rag/core, which excludes PARSER_ERROR — this redaction is defence in depth, no longer the only guard): error-handler.ts
 * sends `payload(code, message)` and tool-error.ts returns
 * `toolError(code, message)`, while an unrecognized error gets a generic
 * string. A RagError carrying document text in its message breaks that
 * contract, so this keeps the contract true. The nearest in-repo principle is
 * `RedactionFinding` (packages/core/src/content-safety.ts:30-35) carrying
 * `kind` + `count` and never the matched value — that governs the finding
 * object, so applying it to a message is an extension, not an existing rule.
 *
 * Scope, narrowed three times under review and worth stating exactly:
 *   - NOT client-facing today: the parser client is constructed only in
 *     apps/worker, so no route or MCP tool can reach a ParserError;
 *   - NOT in the durable audit trail: failed-documents.ts:38 records
 *     `${name} (${code})` and never `err.message`;
 *   - NOT removed from the logs either: pino folds the cause chain back into
 *     the serialized message (`messageWithCauses`), so the body still appears
 *     in the log line. That is deliberate — the log is where it belongs.
 * What remains is that the `.message` property itself is clean, which is what
 * a transport would read.
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

  it("wraps the body in an Error so pino still logs it", async () => {
    // The first cut of this fix passed the body as a bare *string* cause. That
    // reads back fine from JS via `err.cause`, which is why the original test
    // passed -- but pino-std-serializers only walks a cause it considers
    // error-like, so a string cause is dropped from the log entirely. The body
    // was deleted rather than relocated, which is the opposite of the intent.
    //
    // Verified empirically against the installed pino-std-serializers@7.1.0:
    // with a string cause the serialized keys are type/message/stack/code/name
    // and the body is absent; with an Error cause the body is present.
    // Asserting the type here is the dependency-free form of that check --
    // neither pino nor its serializer is a dependency of @rag/rag.
    requestMock.mockResolvedValue({
      statusCode: 422,
      body: { text: async () => SENSITIVE },
    });
    const client = new HttpParserClient("http://parser:8000", 1000);

    const err = (await client
      .parse(input)
      .catch((e: unknown) => e)) as Error & {
      cause?: unknown;
    };

    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain("Jane Doe");
    expect(err.message).not.toContain("Jane Doe");
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
    const transportErr = Object.assign(
      new Error("connect ECONNREFUSED 10.0.0.5:8000"),
      { code: "ECONNREFUSED" }, // undici sets this; omitting it tested only the fallback
    );
    requestMock.mockRejectedValue(transportErr);
    const client = new HttpParserClient("http://parser:8000", 1000);

    const err = (await client
      .parse(input)
      .catch((e: unknown) => e)) as Error & { cause?: unknown };

    // The category survives into the message; the host and port do not.
    expect(err.message).toContain("ECONNREFUSED");
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

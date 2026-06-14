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

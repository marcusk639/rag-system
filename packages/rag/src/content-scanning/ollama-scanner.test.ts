import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressPolicy, ComplianceError } from "@rag/core";
import {
  OllamaContentScanner,
  createContentScanner,
} from "./ollama-scanner.js";

const ALLOW_TEST_HOST = () => new EgressPolicy(["ollama.test"]);
/** The scanner asserts egress at CONSTRUCTION, so a factory test that is
 * about the compliance gate still has to allow-list its host or it fails on
 * egress before reaching the assertion under test. */
const allow = (...hosts: string[]) => new EgressPolicy(hosts);
const ALLOW_ANY_TEST_HOST = () =>
  allow(
    "ollama.railway.internal",
    "127.0.0.1",
    "localhost",
    "10.0.0.5",
    "192.168.1.5",
    "172.16.0.5",
    "ollama",
    "api.openai.com",
  );

function scanner(
  overrides: Partial<
    ConstructorParameters<typeof OllamaContentScanner>[0]
  > = {},
) {
  return new OllamaContentScanner({
    baseUrl: "http://ollama.test:11434/v1",
    model: "llama3.2:3b",
    egressPolicy: ALLOW_TEST_HOST(),
    ...overrides,
  });
}

/** `scanWindow` reads the body with `text()` and parses it itself, so that
 * V8's SyntaxError — which quotes the offending input — never reaches a log
 * or the quarantine reason. These mocks therefore supply `text()`. */
function mockChatResponse(content: string, ok = true) {
  return mockRawResponse(
    JSON.stringify({ choices: [{ message: { content } }] }),
    ok,
  );
}

function mockRawResponse(body: string, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: async () => body,
  });
}

describe("OllamaContentScanner — scan()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns flagged: false on a clean verdict", async () => {
    vi.stubGlobal(
      "fetch",
      mockChatResponse('{"flagged": false, "findings": []}'),
    );
    const result = await scanner().scan("A generic filing checklist.");
    expect(result).toEqual({ flagged: false, findings: [] });
  });

  it("returns flagged: true with findings when the model detects client context", async () => {
    vi.stubGlobal(
      "fetch",
      mockChatResponse(
        // Category only, never a value — the prompt forbids lifting a name
        // into a finding, because findings reach worker logs and the audit row.
        '{"flagged": true, "findings": ["client name"]}',
      ),
    );
    const result = await scanner().scan("Letter for John Smith.");
    expect(result.flagged).toBe(true);
    expect(result.findings).toEqual(["client name"]);
  });

  it("parses JSON embedded in surrounding prose, since not every model obeys 'JSON only'", async () => {
    vi.stubGlobal(
      "fetch",
      mockChatResponse(
        'Here is my answer:\n{"flagged": true, "findings": ["name"]}\nHope that helps!',
      ),
    );
    const result = await scanner().scan("text");
    expect(result.flagged).toBe(true);
  });

  it("throws rather than defaulting to flagged:false when the response has no parseable JSON", async () => {
    // Fail closed: a scanner that defaults to "clean" on a malformed response
    // manufactures confidence — the same failure mode `redactOrThrow` guards.
    vi.stubGlobal("fetch", mockChatResponse("I'm not sure, maybe?"));
    await expect(scanner().scan("text")).rejects.toThrow();
  });

  it("throws when the HTTP call itself fails", async () => {
    vi.stubGlobal("fetch", mockChatResponse("x", false));
    await expect(scanner().scan("text")).rejects.toThrow();
  });

  // The previous version of this test passed `content: ""` together with
  // `ok: false`, so it read as covering two cases while the HTTP check
  // short-circuited before the content check ever ran.
  it.each([
    ["no choices", { choices: [] }],
    ["empty body", {}],
    ["choice with no message", { choices: [{}] }],
    ["message with no content", { choices: [{ message: {} }] }],
    ["empty-string content", { choices: [{ message: { content: "" } }] }],
  ])("throws when the reply has %s", async (_label, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      }),
    );
    await expect(scanner().scan("text")).rejects.toThrow();
  });

  it("throws rather than reading a non-boolean 'flagged' as clean", async () => {
    // The likeliest small-model deviation: a stringified boolean. Read as
    // falsy it would pass a flagged document straight through.
    vi.stubGlobal(
      "fetch",
      mockChatResponse('{"flagged": "yes", "findings": []}'),
    );
    await expect(scanner().scan("text")).rejects.toThrow();
  });

  it("treats findings as authoritative when the model answers flagged:false", async () => {
    // The one combination where a detection would otherwise vanish silently:
    // the caller only logs findings when flagged, so false + findings means
    // the document indexes AND the finding is discarded.
    vi.stubGlobal(
      "fetch",
      mockChatResponse('{"flagged": false, "findings": ["client name"]}'),
    );
    const result = await scanner().scan("text");
    expect(result.flagged).toBe(true);
    expect(result.findings).toEqual(["client name"]);
  });

  it("throws when the model flags a document but records no finding", async () => {
    // Quarantining here would write an audit row stating no reason.
    vi.stubGlobal(
      "fetch",
      mockChatResponse('{"flagged": true, "findings": []}'),
    );
    await expect(scanner().scan("text")).rejects.toThrow(/no findings/);
  });

  it("propagates a request timeout rather than swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")),
    );
    await expect(scanner().scan("text")).rejects.toThrow();
  });

  it("refuses to construct against a host outside the egress allow-list", () => {
    // At construction, not at scan time: an allow-list gap should stop the
    // worker at startup, not quarantine a corpus one document at a time.
    expect(
      () =>
        new OllamaContentScanner({
          baseUrl: "http://evil.example:11434/v1",
          model: "llama3.2:3b",
          egressPolicy: ALLOW_TEST_HOST(),
        }),
    ).toThrow();
  });

  it("sends the model and wraps the text in document delimiters", async () => {
    const fetchMock = mockChatResponse('{"flagged": false, "findings": []}');
    vi.stubGlobal("fetch", fetchMock);
    await scanner().scan("hello world");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.model).toBe("llama3.2:3b");
    expect(body.messages[1].content).toBe(
      "<document>\nhello world\n</document>",
    );
  });

  it("scans the whole document in windows, not just the first 8000 chars", async () => {
    // A client first named on page 3 of a long engagement letter must still be
    // seen. Window 1 is clean, window 3 flags.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              { message: { content: '{"flagged": false, "findings": []}' } },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              { message: { content: '{"flagged": false, "findings": []}' } },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"flagged": true, "findings": ["client name"]}',
                },
              },
            ],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scanner().scan("x".repeat(8000 * 3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.flagged).toBe(true);
    expect(result.findings).toEqual(["client name"]);
  });

  it("stops at the first flagged window", async () => {
    const fetchMock = mockChatResponse(
      '{"flagged": true, "findings": ["client name"]}',
    );
    vi.stubGlobal("fetch", fetchMock);
    await scanner().scan("x".repeat(8000 * 4));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a document too large to scan in full rather than sampling it", async () => {
    const fetchMock = mockChatResponse('{"flagged": false, "findings": []}');
    vi.stubGlobal("fetch", fetchMock);
    await expect(scanner().scan("x".repeat(8000 * 25))).rejects.toThrow(
      /cannot be scanned in full/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createContentScanner", () => {
  it("returns undefined for provider 'none'", () => {
    expect(createContentScanner({ provider: "none" })).toBeUndefined();
  });

  it("builds an OllamaContentScanner for provider 'ollama'", () => {
    const s = createContentScanner(
      {
        provider: "ollama",
        baseUrl: "http://ollama.test:11434/v1",
        model: "llama3.2:3b",
      },
      { egressPolicy: allow("ollama.test") },
    );
    expect(s?.name).toBe("ollama");
  });

  it("throws when provider 'ollama' is missing a base URL or model", () => {
    expect(() =>
      createContentScanner({ provider: "ollama", model: "llama3.2:3b" }),
    ).toThrow();
    expect(() =>
      createContentScanner({ provider: "ollama", baseUrl: "http://x:1/v1" }),
    ).toThrow();
  });

  describe("COMPLIANCE_MODE=client-data", () => {
    // Content-scan's "ollama" provider is ambiguous in a way embeddings/
    // reranker providers are not: it's an OpenAI-compatible shim that can
    // point at genuinely self-hosted infrastructure OR a misconfigured real
    // third-party API, so the gate must distinguish those, not just block
    // the provider name outright the way createReranker/createEmbeddingProvider
    // do for providers that are always third-party.
    it("allows a self-hosted baseUrl (Railway private network)", () => {
      expect(() =>
        createContentScanner(
          {
            provider: "ollama",
            baseUrl: "http://ollama.railway.internal:11434/v1",
            model: "llama3.2:3b",
          },
          {
            complianceMode: "client-data",
            egressPolicy: ALLOW_ANY_TEST_HOST(),
          },
        ),
      ).not.toThrow();
    });

    it("allows a self-hosted baseUrl (loopback / private IP ranges)", () => {
      for (const baseUrl of [
        "http://127.0.0.1:11434/v1",
        "http://localhost:11434/v1",
        "http://10.0.0.5:11434/v1",
        "http://192.168.1.5:11434/v1",
        "http://172.16.0.5:11434/v1",
      ]) {
        expect(() =>
          createContentScanner(
            { provider: "ollama", baseUrl, model: "llama3.2:3b" },
            {
              complianceMode: "client-data",
              egressPolicy: ALLOW_ANY_TEST_HOST(),
            },
          ),
        ).not.toThrow();
      }
    });

    it("refuses a baseUrl that is not recognizably self-hosted", () => {
      expect(() =>
        createContentScanner(
          {
            provider: "ollama",
            baseUrl: "https://api.openai.com/v1",
            model: "llama3.2:3b",
          },
          {
            complianceMode: "client-data",
            egressPolicy: ALLOW_ANY_TEST_HOST(),
          },
        ),
      ).toThrow(ComplianceError);
    });

    it("allows provider 'none' regardless of complianceMode", () => {
      expect(
        createContentScanner(
          { provider: "none" },
          {
            complianceMode: "client-data",
            egressPolicy: ALLOW_ANY_TEST_HOST(),
          },
        ),
      ).toBeUndefined();
    });

    it("does not restrict baseUrl when complianceMode is not client-data", () => {
      expect(() =>
        createContentScanner(
          {
            provider: "ollama",
            baseUrl: "https://api.openai.com/v1",
            model: "llama3.2:3b",
          },
          { egressPolicy: allow("api.openai.com") },
        ),
      ).not.toThrow();
    });
  });
});

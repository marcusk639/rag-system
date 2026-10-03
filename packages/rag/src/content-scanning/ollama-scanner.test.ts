import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressPolicy } from "@rag/core";
import {
  OllamaContentScanner,
  createContentScanner,
} from "./ollama-scanner.js";

const ALLOW_TEST_HOST = () => new EgressPolicy(["ollama.test"]);

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

function mockChatResponse(content: string, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ choices: [{ message: { content } }] }),
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
        '{"flagged": true, "findings": ["client name: John Smith"]}',
      ),
    );
    const result = await scanner().scan("Letter for John Smith.");
    expect(result.flagged).toBe(true);
    expect(result.findings).toEqual(["client name: John Smith"]);
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
    vi.stubGlobal("fetch", mockChatResponse("", false));
    await expect(scanner().scan("text")).rejects.toThrow();
  });

  it("throws when the request targets a host outside the egress allow-list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = new OllamaContentScanner({
      baseUrl: "http://evil.example:11434/v1",
      model: "llama3.2:3b",
      egressPolicy: ALLOW_TEST_HOST(),
    });
    await expect(s.scan("text")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the model and a bounded excerpt of the text", async () => {
    const fetchMock = mockChatResponse('{"flagged": false, "findings": []}');
    vi.stubGlobal("fetch", fetchMock);
    await scanner().scan("hello world");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.model).toBe("llama3.2:3b");
    expect(JSON.stringify(body.messages)).toContain("hello world");
  });
});

describe("createContentScanner", () => {
  it("returns undefined for provider 'none'", () => {
    expect(createContentScanner({ provider: "none" })).toBeUndefined();
  });

  it("builds an OllamaContentScanner for provider 'ollama'", () => {
    const s = createContentScanner({
      provider: "ollama",
      baseUrl: "http://ollama.test:11434/v1",
      model: "llama3.2:3b",
    });
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
});

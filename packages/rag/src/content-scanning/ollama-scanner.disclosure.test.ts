import { describe, expect, it, vi, afterEach } from "vitest";
import { EgressPolicy, ComplianceError, classifyScanFailure } from "@rag/core";
import {
  OllamaContentScanner,
  createContentScanner,
  isLikelySelfHosted,
} from "./ollama-scanner.js";

/**
 * Disclosure-path regressions for Layer 1.5.
 *
 * Every test here asserts on what the scanner is allowed to SAY, not on
 * whether it says something. The scanner's whole purpose is to decide what is
 * safe to send elsewhere, so each of its own error paths is a place document
 * text can escape into `ingest_log.rejection_reason` and worker logs.
 *
 * The token below stands in for a client name. It must never appear in a
 * thrown message, a finding, or a log binding — a test that only asserts
 * "throws" would pass while the name travelled inside the message.
 */
const CLIENT_TOKEN = "Brightwater Holdings";

/** Reply mock that answers BOTH `text()` and `json()`, so these tests hold
 * whether the implementation reads the body as text and parses it itself or
 * calls `response.json()`. `json()` runs the real `JSON.parse`, so V8's own
 * SyntaxError — which quotes the offending input — is what the code under
 * test actually sees. Faking that error would be testing the fake. */
function reply(body: string, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: async () => body,
    json: async () => JSON.parse(body),
  });
}

/** A well-formed chat envelope whose message content is `content`. */
function chatReply(content: string) {
  return reply(JSON.stringify({ choices: [{ message: { content } }] }));
}

function scanner() {
  return new OllamaContentScanner({
    baseUrl: "http://ollama.test:11434/v1",
    model: "llama3.2:3b",
    egressPolicy: new EgressPolicy(["ollama.test"]),
  });
}

/** The message of the rejection, for substring assertions. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the scan to reject, but it resolved");
}

afterEach(() => vi.unstubAllGlobals());

describe("scanner reply that is not JSON at all", () => {
  // V8 quotes the offending input in its SyntaxError ("Unexpected token 'A',
  // \"Acme Trust\"... is not valid JSON"), so an unguarded
  // `await response.json()` carries whatever the scanner replied — which is
  // derived from document text — into the quarantine reason and the log.
  //
  // ⚠ V8 truncates that quote to the first TEN characters of the input. A
  // test whose client token sits past character 10 therefore passes against
  // the unguarded code for a reason that has nothing to do with the fix, and
  // would keep passing if the guard were removed again. The leak is bounded
  // but real, so the token has to sit inside the window to be proof of it.
  const LEAKED_PREFIX = "Acme Trust";
  const NON_JSON = `${LEAKED_PREFIX} engagement letter could not be scanned`;

  it("does not put the reply body in the thrown message", async () => {
    vi.stubGlobal("fetch", reply(NON_JSON));
    const message = await messageOf(scanner().scan("text"));
    expect(message).not.toContain(LEAKED_PREFIX);
  });

  it("reports only the shape and size of the reply", async () => {
    vi.stubGlobal("fetch", reply(NON_JSON));
    const message = await messageOf(scanner().scan("text"));
    expect(message).toMatch(/was not JSON \(\d+ bytes\)/);
  });
});

describe("findings category allowlist", () => {
  it("replaces an off-list finding with 'unrecognized-category'", async () => {
    // The prompt forbids the model from lifting values into findings, but a
    // prompt is not an enforcement boundary: findings are persisted to the
    // audit table and logged, and this is unvalidated model output.
    vi.stubGlobal(
      "fetch",
      chatReply(
        `{"flagged": true, "findings": ["client name", "${CLIENT_TOKEN} FY24 return"]}`,
      ),
    );
    const result = await scanner().scan("text");
    expect(result.findings).toEqual(["client name", "unrecognized-category"]);
  });

  it("passes through every category on the list unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      chatReply(
        '{"flagged": true, "findings": ["client name", "client organization", "identifying fact pattern"]}',
      ),
    );
    const result = await scanner().scan("text");
    expect(result.findings).toEqual([
      "client name",
      "client organization",
      "identifying fact pattern",
    ]);
  });
});

describe("findings that are present but malformed", () => {
  // Both shapes below filter to [] under a `typeof f === "string"` filter
  // applied to a non-array, or to an array of objects — and an empty findings
  // list with `flagged: false` reads as a clean document. A detection the
  // model DID make is then recorded as "nothing found".
  it.each([
    [
      "a bare string instead of an array",
      '{"flagged": false, "findings": "client name"}',
    ],
    [
      "an array of objects instead of strings",
      '{"flagged": false, "findings": [{"category": "client name"}]}',
    ],
    [
      "an array of mixed types",
      '{"flagged": false, "findings": ["client name", 7]}',
    ],
  ])("rejects %s rather than reading it as clean", async (_label, content) => {
    vi.stubGlobal("fetch", chatReply(content));
    await expect(scanner().scan("text")).rejects.toThrow();
  });

  it("still accepts a reply with no findings field at all as clean", async () => {
    // Absent is not malformed: the model answered the question and found
    // nothing. Only a PRESENT value of the wrong shape is a failure.
    vi.stubGlobal("fetch", chatReply('{"flagged": false}'));
    const result = await scanner().scan("text");
    expect(result).toEqual({ flagged: false, findings: [] });
  });

  it("does not echo the malformed value in the thrown message", async () => {
    vi.stubGlobal(
      "fetch",
      chatReply(`{"flagged": false, "findings": "${CLIENT_TOKEN}"}`),
    );
    const message = await messageOf(scanner().scan("text"));
    expect(message).not.toContain(CLIENT_TOKEN);
  });
});

describe("isLikelySelfHosted, via the client-data compliance gate", () => {
  const build = (baseUrl: string, host: string) =>
    createContentScanner(
      { provider: "ollama", baseUrl, model: "m", timeoutMs: 30_000 },
      {
        complianceMode: "client-data",
        egressPolicy: new EgressPolicy([host]),
      },
    );

  it.each([
    [
      "a public host wearing a loopback prefix",
      "http://127.evil.com:11434/v1",
      "127.evil.com",
    ],
    [
      "a loopback-prefixed subdomain",
      "http://127.0.0.1.evil.com:11434/v1",
      "127.0.0.1.evil.com",
    ],
  ])("refuses %s", (_label, baseUrl, host) => {
    // `/^127\./` matches any hostname STARTING with "127." — including a
    // registrable domain. The check has to be a dotted quad to mean loopback.
    expect(() => build(baseUrl, host)).toThrow(ComplianceError);
  });

  it.each([
    ["loopback", "http://127.0.0.1:11434/v1", "127.0.0.1"],
    [
      "a non-.1 loopback address in 127.0.0.0/8",
      "http://127.1.2.3:11434/v1",
      "127.1.2.3",
    ],
  ])("still accepts %s", (_label, baseUrl, host) => {
    expect(() => build(baseUrl, host)).not.toThrow();
  });
});

/**
 * Asserted on the pure function, NOT through `createContentScanner`.
 *
 * Routed through the factory these cases pass for the wrong reason: the
 * scanner asserts egress in its constructor, and an endpoint built from a
 * value with no authority fails the allow-list before the compliance gate is
 * ever consulted. The test would be green while the heuristic still answered
 * "self-hosted".
 */
describe("isLikelySelfHosted", () => {
  it.each([
    // `new URL("ollama.railway.internal:11434")` reads the whole host as a
    // SCHEME and leaves `hostname` empty. An empty hostname contains neither
    // a dot nor a colon, so the single-label branch — meant for
    // Compose/Kubernetes service names like `http://ollama:11434` — accepted
    // it. Any `scheme:path` value with no authority took that path.
    ["a value whose hostname parses empty", "ollama.railway.internal:11434"],
    ["a data: URL", "data:text/plain,x"],
    ["a public host wearing a loopback prefix", "http://127.evil.com:11434/v1"],
    ["a public API host", "https://api.openai.com/v1"],
  ])("rejects %s", (_label, baseUrl) => {
    expect(isLikelySelfHosted(baseUrl)).toBe(false);
  });

  it.each([
    ["loopback", "http://127.0.0.1:11434/v1"],
    ["any address in 127.0.0.0/8", "http://127.1.2.3:11434/v1"],
    ["localhost", "http://localhost:11434/v1"],
    ["a Compose service name", "http://ollama:11434/v1"],
    ["an internal DNS suffix", "http://ollama.railway.internal:11434/v1"],
    ["an RFC1918 address", "http://10.0.0.5:11434/v1"],
  ])("accepts %s", (_label, baseUrl) => {
    expect(isLikelySelfHosted(baseUrl)).toBe(true);
  });
});

describe("scan failures carry their own classification", () => {
  it("classifies a refused connection as scanner-unreachable", async () => {
    // The likeliest real failure: the Ollama service is down. It surfaces as a
    // bare `TypeError: fetch failed` with no classification, which would be
    // recorded as "unknown" and leave the quarantine reason diagnostically
    // empty — the taxonomy would be preserving nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const err = await scanner()
      .scan("text")
      .catch((e: unknown) => e);
    expect(classifyScanFailure(err)).toBe("scanner-unreachable");
  });

  it("classifies a timeout as scanner-unreachable", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    const err = await scanner()
      .scan("text")
      .catch((e: unknown) => e);
    expect(classifyScanFailure(err)).toBe("scanner-unreachable");
  });

  it("classifies an HTTP error as scanner-unreachable", async () => {
    vi.stubGlobal("fetch", reply("nope", false));
    const err = await scanner()
      .scan("text")
      .catch((e: unknown) => e);
    expect(classifyScanFailure(err)).toBe("scanner-unreachable");
  });

  it("classifies a malformed reply as malformed-reply", async () => {
    vi.stubGlobal("fetch", chatReply("no json here"));
    const err = await scanner()
      .scan("text")
      .catch((e: unknown) => e);
    expect(classifyScanFailure(err)).toBe("malformed-reply");
  });

  it("classifies an over-ceiling document as too-large", async () => {
    vi.stubGlobal("fetch", chatReply('{"flagged": false, "findings": []}'));
    const err = await scanner()
      .scan("x".repeat(8000 * 25))
      .catch((e: unknown) => e);
    expect(classifyScanFailure(err)).toBe("too-large");
  });

  it("does not put the network error's own message in the thrown message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("connect ECONNREFUSED Acme")),
    );
    const message = await messageOf(scanner().scan("text"));
    expect(message).not.toContain("Acme");
  });
});

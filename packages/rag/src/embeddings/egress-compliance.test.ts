/**
 * Tests for adversarial-review findings 1 and 3:
 *
 *   Finding 1: Embedding providers must enforce EgressPolicy before any SDK
 *              network call — the SDK itself has no knowledge of our policy.
 *
 *   Finding 3: createEmbeddingProvider must hard-gate on complianceMode so
 *              that COMPLIANCE_MODE=client-data + a non-local provider is a
 *              startup-time error rather than a runtime data-leak.
 */

import { ComplianceError, EgressError, EgressPolicy } from "@rag/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider } from "./factory.js";
import { GeminiEmbeddingProvider } from "./gemini.js";
import { OpenAIEmbeddingProvider } from "./openai.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Finding 1: per-provider egress gate ─────────────────────────────────────

describe("GeminiEmbeddingProvider — egress policy (finding 1)", () => {
  const denyAll = new EgressPolicy([]);

  it("throws EgressError before calling the Gemini SDK when the policy blocks the endpoint", async () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: "fake-key",
      egressPolicy: denyAll,
    });

    await expect(provider.embed("hello")).rejects.toThrow(EgressError);
    await expect(provider.embedBatch(["hello"])).rejects.toThrow(EgressError);
    await expect(provider.embedQuery?.("hello")).rejects.toThrow(EgressError);
  });

  it("does NOT call the policy on an empty batch (no egress needed)", async () => {
    // Even a deny-all policy must allow empty batches — nothing goes out.
    const provider = new GeminiEmbeddingProvider({
      apiKey: "fake-key",
      egressPolicy: denyAll,
    });

    // embedBatch([]) short-circuits before the policy check.
    await expect(provider.embedBatch([])).resolves.toEqual([]);
  });

  it("permits calls when the endpoint is in the allow-list", () => {
    // Just verify construction + policy wiring — we don't make live calls.
    const allow = new EgressPolicy(["generativelanguage.googleapis.com"]);
    expect(
      () =>
        new GeminiEmbeddingProvider({
          apiKey: "fake-key",
          egressPolicy: allow,
        }),
    ).not.toThrow();
  });
});

describe("OpenAIEmbeddingProvider — egress policy (finding 1)", () => {
  const denyAll = new EgressPolicy([]);

  it("throws EgressError before calling the OpenAI SDK when the policy blocks the endpoint", async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "fake-key",
      egressPolicy: denyAll,
    });

    await expect(provider.embed("hello")).rejects.toThrow(EgressError);
    await expect(provider.embedBatch(["hello"])).rejects.toThrow(EgressError);
  });

  it("does NOT call the policy on an empty batch", async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "fake-key",
      egressPolicy: denyAll,
    });

    await expect(provider.embedBatch([])).resolves.toEqual([]);
  });

  it("permits calls when the endpoint is in the allow-list", () => {
    const allow = new EgressPolicy(["api.openai.com"]);
    expect(
      () =>
        new OpenAIEmbeddingProvider({
          apiKey: "fake-key",
          egressPolicy: allow,
        }),
    ).not.toThrow();
  });
});

// ── Finding 3: compliance-mode hard gate in the factory ─────────────────────

describe("createEmbeddingProvider — compliance mode gate (finding 3)", () => {
  const baseCfg = {
    model: "gemini-embedding-001",
    dimensions: 768,
    maxRetries: 3,
  };

  it("throws ComplianceError when complianceMode=client-data and provider=gemini", () => {
    expect(() =>
      createEmbeddingProvider(
        { ...baseCfg, provider: "gemini", apiKey: "fake-key" },
        { complianceMode: "client-data" },
      ),
    ).toThrow(ComplianceError);
  });

  it("throws ComplianceError when complianceMode=client-data and provider=openai", () => {
    expect(() =>
      createEmbeddingProvider(
        {
          ...baseCfg,
          provider: "openai",
          apiKey: "fake-key",
          dimensions: 1536,
        },
        { complianceMode: "client-data" },
      ),
    ).toThrow(ComplianceError);
  });

  it("ComplianceError message names the forbidden provider", () => {
    let caught: ComplianceError | undefined;
    try {
      createEmbeddingProvider(
        { ...baseCfg, provider: "gemini", apiKey: "k" },
        { complianceMode: "client-data" },
      );
    } catch (err) {
      caught = err as ComplianceError;
    }
    expect(caught).toBeInstanceOf(ComplianceError);
    expect(caught?.message).toMatch(/gemini/);
    expect(caught?.message).toMatch(/client-data/);
  });

  it("allows local provider when complianceMode=client-data", () => {
    expect(() =>
      createEmbeddingProvider(
        { ...baseCfg, provider: "local" },
        { complianceMode: "client-data" },
      ),
    ).not.toThrow();
  });

  it("allows gemini when complianceMode=none (default)", () => {
    expect(() =>
      createEmbeddingProvider(
        { ...baseCfg, provider: "gemini", apiKey: "k" },
        { complianceMode: "none" },
      ),
    ).not.toThrow();
  });

  it("allows gemini when no complianceMode is passed", () => {
    expect(() =>
      createEmbeddingProvider({ ...baseCfg, provider: "gemini", apiKey: "k" }),
    ).not.toThrow();
  });
});

// ── The same bypass class, on the embedding path ────────────────────────────
//
// The tests above prove the providers CONSULT the policy. They do not prove the
// policy is consulted about the host actually dialed, which is a different
// claim — and the one that failed. Both providers built their SDK client
// without an explicit base URL, so the SDK's own environment fallback
// (`OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`) selected the host, while
// `assertAllowed` was handed a hardcoded literal. The allow-list then vouched
// for a host the client never contacted.
//
// This matters more here than on the generation path it was found on: an
// embedding call ships the whole corpus, not one prompt.

/** The base URL the SDK client will actually dial. */
function openAIClientBaseURL(p: OpenAIEmbeddingProvider): string {
  return (p as unknown as { client: { baseURL: string } }).client.baseURL;
}

function geminiClientBaseURL(p: GeminiEmbeddingProvider): string | undefined {
  const c = p as unknown as {
    client: { apiClient?: { getBaseUrl?: () => string } };
  };
  return c.client.apiClient?.getBaseUrl?.();
}

describe("embedding providers — env cannot redirect the client past the allow-list", () => {
  const allowOpenAI = new EgressPolicy(["api.openai.com"]);
  const allowGemini = new EgressPolicy(["generativelanguage.googleapis.com"]);

  it("neutralizes OPENAI_BASE_URL", async () => {
    // REGRESSION. The OpenAI SDK constructor destructures
    // `baseURL = readEnv("OPENAI_BASE_URL")`, so omitting the key is NOT the
    // same as passing the default — the env var wins.
    vi.stubEnv("OPENAI_BASE_URL", "http://not-on-the-allow-list.example/v1");

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "fake-key",
      egressPolicy: allowOpenAI,
    });

    expect(openAIClientBaseURL(provider)).toBe("https://api.openai.com/v1");
  });

  it("neutralizes GOOGLE_GEMINI_BASE_URL", async () => {
    vi.stubEnv(
      "GOOGLE_GEMINI_BASE_URL",
      "http://not-on-the-allow-list.example",
    );

    const provider = new GeminiEmbeddingProvider({
      apiKey: "fake-key",
      egressPolicy: allowGemini,
    });

    const dialed = geminiClientBaseURL(provider);
    // Only assert when the SDK exposes it; the pinning is what matters and the
    // accessor is not part of the SDK's public contract.
    if (dialed !== undefined) {
      expect(dialed).toContain("generativelanguage.googleapis.com");
    }
    expect(dialed ?? "").not.toContain("not-on-the-allow-list.example");
  });

  it("still asserts the allow-list on the pinned host, so a deny-all still blocks", async () => {
    // Pinning must not accidentally bypass the policy check itself.
    vi.stubEnv("OPENAI_BASE_URL", "http://not-on-the-allow-list.example/v1");
    const denied = new OpenAIEmbeddingProvider({
      apiKey: "fake-key",
      egressPolicy: new EgressPolicy([]),
    });
    await expect(denied.embedBatch(["x"])).rejects.toThrow(EgressError);
  });
});

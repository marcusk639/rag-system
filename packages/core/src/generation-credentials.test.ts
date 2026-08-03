import { describe, expect, it } from "vitest";
import {
  LOCAL_ENDPOINT_PLACEHOLDER_KEY,
  resolveGenerationCredentials,
} from "./generation-credentials.js";

describe("resolveGenerationCredentials", () => {
  it("prefers an explicit generation key over the embedding key", () => {
    // Mixed vendors (Gemini embeddings, OpenAI generation) is a real
    // configuration; inheriting silently would send the wrong key.
    expect(
      resolveGenerationCredentials({
        generationApiKey: "gen-key",
        embeddingApiKey: "embed-key",
      }),
    ).toEqual({ kind: "ok", apiKey: "gen-key" });
  });

  it("inherits the embedding key when no generation key is set", () => {
    // Preserves the pre-existing single-vendor behavior.
    expect(
      resolveGenerationCredentials({ embeddingApiKey: "embed-key" }),
    ).toEqual({ kind: "ok", apiKey: "embed-key" });
  });

  it("supplies a placeholder for a keyless local endpoint", () => {
    // EMBEDDING_PROVIDER=local means there is no embedding key to inherit.
    // Without this branch the headline air-gapped configuration silently
    // disables generation, because the SDK requires a non-empty key.
    expect(
      resolveGenerationCredentials({ baseURL: "http://127.0.0.1:11434/v1" }),
    ).toEqual({ kind: "ok", apiKey: LOCAL_ENDPOINT_PLACEHOLDER_KEY });
  });

  it("still prefers a real key over the placeholder when both apply", () => {
    expect(
      resolveGenerationCredentials({
        embeddingApiKey: "embed-key",
        baseURL: "http://127.0.0.1:11434/v1",
      }),
    ).toEqual({ kind: "ok", apiKey: "embed-key" });
  });

  it("disables generation when there is no key and no local endpoint", () => {
    const result = resolveGenerationCredentials({});
    expect(result.kind).toBe("disabled");
  });

  it("treats whitespace-only values as absent", () => {
    // A key set to "" or " " in a .env is the common way this is misconfigured,
    // and the SDK would accept it and fail later at the provider.
    const result = resolveGenerationCredentials({
      generationApiKey: "   ",
      embeddingApiKey: "",
    });
    expect(result.kind).toBe("disabled");
  });

  it("trims a padded key rather than passing the padding through", () => {
    expect(
      resolveGenerationCredentials({ generationApiKey: "  gen-key  " }),
    ).toEqual({ kind: "ok", apiKey: "gen-key" });
  });
});

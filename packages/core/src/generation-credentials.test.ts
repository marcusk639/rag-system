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

  it("never forwards an inherited hosted-vendor key to a self-hosted endpoint", () => {
    // DELIBERATE ORDER — do not "restore" inheritance ahead of this branch.
    // An earlier revision preferred the inherited key here. That meant
    // EMBEDDING_PROVIDER=gemini plus GENERATION_BASE_URL=http://127.0.0.1:11434/v1
    // sent `Authorization: Bearer <GEMINI_API_KEY>` to that endpoint. It
    // contradicts the reasoning the rest of this feature rests on: if a local
    // host is not trusted enough to relax the TRI scan (localhost can be an SSH
    // tunnel), it is not trusted enough to be handed a production API key by
    // default. GENERATION_API_KEY remains the escape hatch for a self-hosted
    // server that genuinely requires auth.
    expect(
      resolveGenerationCredentials({
        embeddingApiKey: "embed-key",
        baseURL: "http://127.0.0.1:11434/v1",
      }),
    ).toEqual({ kind: "ok", apiKey: LOCAL_ENDPOINT_PLACEHOLDER_KEY });
  });

  it("still lets an explicit generation key reach a self-hosted endpoint", () => {
    // The escape hatch: llama.cpp `--api-key`, vLLM `--api-key`, a reverse proxy.
    expect(
      resolveGenerationCredentials({
        generationApiKey: "gen-key",
        embeddingApiKey: "embed-key",
        baseURL: "http://127.0.0.1:11434/v1",
      }),
    ).toEqual({ kind: "ok", apiKey: "gen-key" });
  });

  it("disables generation when there is no key and no local endpoint", () => {
    const result = resolveGenerationCredentials({});
    expect(result.kind).toBe("disabled");
    // Pinned because this string is what an operator reads in the boot log when
    // generation silently turns itself off. It named a nonexistent
    // `EMBEDDING_API_KEY`, telling them to set a variable this codebase never
    // reads.
    expect(result.kind === "disabled" && result.reason).toBe(
      "no GENERATION_API_KEY, no embedding API key to inherit " +
        "(GEMINI_API_KEY or OPENAI_API_KEY, per EMBEDDING_PROVIDER), " +
        "and no GENERATION_BASE_URL",
    );
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

/**
 * Which API key generation should use, and whether generation is viable at all.
 *
 * Generation historically borrowed `config.embedding.apiKey` on the assumption
 * that embeddings and generation come from the same vendor. That assumption
 * breaks in exactly the deployment this exists to serve: `EMBEDDING_PROVIDER=
 * local` needs no key, so a self-hosted generation endpoint paired with local
 * embeddings would find no key and disable itself.
 *
 * Precedence, in order:
 *
 * 1. `GENERATION_API_KEY` — explicit, wins everywhere including self-hosted.
 * 2. A self-hosted endpoint (`GENERATION_BASE_URL` set) gets the placeholder.
 *    It never inherits, because inheriting would mail a hosted vendor's
 *    production key to a host we cannot verify — the same reason `triPolicy`
 *    is not inferred from a local-looking endpoint.
 * 3. The embedding provider's key, for the single-vendor hosted case.
 */
export interface GenerationCredentialInput {
  /** `GENERATION_API_KEY` — explicit, wins over everything. */
  generationApiKey?: string | undefined;
  /**
   * The embedding provider's key — `GEMINI_API_KEY` or `OPENAI_API_KEY`,
   * whichever `EMBEDDING_PROVIDER` selects. Inherited only when generation has
   * no key of its own AND no self-hosted endpoint is configured.
   */
  embeddingApiKey?: string | undefined;
  /** `GENERATION_BASE_URL` — presence means a self-hosted endpoint. */
  baseURL?: string | undefined;
}

export type GenerationCredentials =
  { kind: "ok"; apiKey: string } | { kind: "disabled"; reason: string };

/**
 * Sent to self-hosted endpoints, which ignore the value. The OpenAI SDK
 * rejects an empty `apiKey`, so something must be supplied; naming it plainly
 * beats an empty string that reads like a bug in logs.
 */
export const LOCAL_ENDPOINT_PLACEHOLDER_KEY = "local-endpoint-no-key";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveGenerationCredentials(
  input: GenerationCredentialInput,
): GenerationCredentials {
  const explicit = clean(input.generationApiKey);
  if (explicit) return { kind: "ok", apiKey: explicit };

  // A self-hosted endpoint gets the placeholder, never a hosted vendor's key.
  // "Looks local" is not verifiable — the same reason triPolicy is not inferred
  // from the endpoint. `GENERATION_API_KEY` above is the escape hatch for a
  // self-hosted server that does require auth (e.g. llama.cpp `--api-key`).
  if (clean(input.baseURL)) {
    return { kind: "ok", apiKey: LOCAL_ENDPOINT_PLACEHOLDER_KEY };
  }

  const inherited = clean(input.embeddingApiKey);
  if (inherited) return { kind: "ok", apiKey: inherited };

  return {
    kind: "disabled",
    reason:
      "no GENERATION_API_KEY, no embedding API key to inherit " +
      "(GEMINI_API_KEY or OPENAI_API_KEY, per EMBEDDING_PROVIDER), " +
      "and no GENERATION_BASE_URL",
  };
}

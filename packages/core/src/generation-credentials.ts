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
 * 3. The embedding provider's key, for the single-vendor hosted case — and
 *    ONLY when the two vendors actually match. See `generationProvider` below.
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
  /**
   * `GENERATION_PROVIDER` / `EMBEDDING_PROVIDER`. Supplied together, they gate
   * rule 3: a key is inherited only when both name the SAME vendor.
   *
   * This exists because rule 3's "single-vendor hosted case" stopped being
   * implied by "an embedding key exists" once `claude` became selectable.
   * Anthropic is not an embedding provider here, so for `claude` the
   * single-vendor case cannot arise, and inheriting would send a live Gemini
   * or OpenAI secret to api.anthropic.com — a credential disclosure to a third
   * party, not merely a 401.
   *
   * Omitting them preserves the pre-existing behaviour for callers that have
   * not been updated; every in-repo caller supplies them.
   */
  generationProvider?: string | undefined;
  embeddingProvider?: string | undefined;
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

  const generationProvider = clean(input.generationProvider);
  const embeddingProvider = clean(input.embeddingProvider);
  const vendorsDiffer =
    generationProvider !== undefined &&
    embeddingProvider !== undefined &&
    generationProvider !== embeddingProvider;

  if (vendorsDiffer) {
    return {
      kind: "disabled",
      reason:
        `GENERATION_PROVIDER=${generationProvider} cannot inherit the ` +
        `${embeddingProvider} embedding key — that would disclose one vendor's ` +
        `credential to another. Set GENERATION_API_KEY explicitly.`,
    };
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

/**
 * Which API key generation should use, and whether generation is viable at all.
 *
 * Generation historically borrowed `config.embedding.apiKey` on the assumption
 * that embeddings and generation come from the same vendor. That assumption
 * breaks in exactly the deployment this exists to serve: `EMBEDDING_PROVIDER=
 * local` needs no key, so a self-hosted generation endpoint paired with local
 * embeddings would find no key and disable itself.
 */
export interface GenerationCredentialInput {
  /** `GENERATION_API_KEY` — explicit, wins over everything. */
  generationApiKey?: string | undefined;
  /** `EMBEDDING_API_KEY` — inherited when generation has none of its own. */
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

  const inherited = clean(input.embeddingApiKey);
  if (inherited) return { kind: "ok", apiKey: inherited };

  if (clean(input.baseURL)) {
    return { kind: "ok", apiKey: LOCAL_ENDPOINT_PLACEHOLDER_KEY };
  }

  return {
    kind: "disabled",
    reason:
      "no GENERATION_API_KEY, no EMBEDDING_API_KEY to inherit, and no GENERATION_BASE_URL",
  };
}

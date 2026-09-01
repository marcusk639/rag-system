import { GoogleGenAI } from "@google/genai";
import type { Embedding, EmbeddingProvider } from "@rag/core";
import { EgressPolicy, EmbeddingError } from "@rag/core";
import { retryOnRateLimit } from "./retry.js";
import { createThrottle } from "./throttle.js";

/**
 * Gemini embedding provider.
 *
 * Default model: `gemini-embedding-001` — the current GA embedding model.
 * `text-embedding-004` was retired on the Gemini API and now 404s on
 * `embedContent`. `gemini-embedding-001` supports Matryoshka output dims via
 * `outputDimensionality`, so it still emits 768-d vectors to match the
 * `chunks.embedding` column (no index migration needed).
 *
 * Docs: https://ai.google.dev/gemini-api/docs/embeddings
 */
/**
 * The host this provider dials, pinned. See the matching constant in
 * `openai.ts` for why the client and the egress assertion must read the same
 * value rather than each deciding for itself.
 */
const GEMINI_EMBEDDINGS_BASE_URL = "https://generativelanguage.googleapis.com";

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly dimensions: number;
  private client: GoogleGenAI;
  private readonly maxRetries: number;
  private readonly _egressPolicy: EgressPolicy;
  private readonly _throttle: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    maxRetries?: number;
    egressPolicy?: EgressPolicy;
    /** Pace embedding requests to at most N per minute. 0/undefined = unpaced. */
    requestsPerMinute?: number;
  }) {
    if (!opts.apiKey) {
      throw new EmbeddingError("Gemini API key is required");
    }
    this.client = new GoogleGenAI({
      apiKey: opts.apiKey,
      // Passed explicitly, never omitted: the SDK falls back to
      // `GOOGLE_GEMINI_BASE_URL` when this key is absent, which would let an
      // environment variable redirect the client away from the host asserted
      // against the allow-list below.
      httpOptions: {
        baseUrl: GEMINI_EMBEDDINGS_BASE_URL,
        // NOTE: redirects are NOT refused on this path. @google/genai@1.52.0's
        // public HttpOptions exposes no `redirect` option and no custom-fetch
        // hook (only baseUrl/apiVersion/headers/timeout/extraBody/retryOptions),
        // so the OpenAI path's `egressSafeFetch` has no equivalent here. The
        // allow-list therefore validates the first hop only for Gemini. See
        // NO_REDIRECT_INIT in @rag/core; closing this needs an SDK change or a
        // hand-rolled transport.
      },
    });
    this.model = opts.model ?? "gemini-embedding-001";
    this.dimensions = opts.dimensions ?? 768;
    this.maxRetries = opts.maxRetries ?? 5;
    this._egressPolicy = opts.egressPolicy ?? EgressPolicy.fromEnv();
    this._throttle = createThrottle({
      ...(opts.requestsPerMinute !== undefined
        ? { requestsPerMinute: opts.requestsPerMinute }
        : {}),
    });
  }

  async embed(text: string): Promise<Embedding> {
    const [vec] = await this.embedBatch([text]);
    if (!vec) throw new EmbeddingError("Gemini returned no embedding");
    return vec;
  }

  /**
   * Embed a search QUERY. Gemini retrieval embeddings are asymmetric: the query
   * side must use `RETRIEVAL_QUERY` while the corpus side uses
   * `RETRIEVAL_DOCUMENT`. Embedding a query with the document task type silently
   * degrades retrieval, so the retriever calls this — not `embed`.
   */
  async embedQuery(text: string): Promise<Embedding> {
    const [vec] = await this.embedWithTaskType([text], "RETRIEVAL_QUERY");
    if (!vec) throw new EmbeddingError("Gemini returned no embedding");
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    // Corpus/document side of the asymmetric retrieval-embedding pair.
    return this.embedWithTaskType(texts, "RETRIEVAL_DOCUMENT");
  }

  private async embedWithTaskType(
    texts: string[],
    taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  ): Promise<Embedding[]> {
    if (texts.length === 0) return [];

    this._egressPolicy.assertAllowed(GEMINI_EMBEDDINGS_BASE_URL);

    try {
      // Gemini's batch endpoint accepts up to 100 inputs per call.
      const results: Embedding[] = [];
      const batchSize = 100;
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        const response = await this._throttle(() =>
          retryOnRateLimit(
            () =>
              this.client.models.embedContent({
                model: this.model,
                contents: slice,
                config: {
                  outputDimensionality: this.dimensions,
                  taskType,
                },
              }),
            { maxRetries: this.maxRetries },
          ),
        );
        const embeddings = response.embeddings ?? [];
        if (embeddings.length !== slice.length) {
          throw new EmbeddingError(
            `Gemini returned ${embeddings.length} embeddings for ${slice.length} inputs`,
          );
        }
        for (const e of embeddings) {
          const values = e.values ?? [];
          results.push({
            vector: values,
            provider: this.name,
            model: this.model,
            dimensions: values.length,
          });
        }
      }
      return results;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `Gemini embedding failed: ${(err as Error).message}`,
        err,
      );
    }
  }
}

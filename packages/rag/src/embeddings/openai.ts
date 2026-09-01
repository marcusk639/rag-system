import OpenAI from "openai";
import type { Embedding, EmbeddingProvider } from "@rag/core";
import { EgressPolicy, EmbeddingError, egressSafeFetch } from "@rag/core";
import { retryOnRateLimit } from "./retry.js";
import { createThrottle } from "./throttle.js";

/**
 * OpenAI embedding provider. Use when you want maximum quality and don't
 * mind paying. `text-embedding-3-small` is 1536-dim, `-large` is 3072-dim.
 *
 * If you switch from Gemini (768) to OpenAI, you MUST change the vector
 * column dimension in the `chunks` table and re-embed everything.
 * See packages/db/drizzle/0000_init.sql for the migration recipe.
 */
/**
 * The host this provider dials, pinned.
 *
 * Both the SDK client and the egress assertion below read this one value, which
 * is the whole point: when they were allowed to disagree — a hardcoded literal
 * in the assertion, an env-derived default in the client — the allow-list
 * approved `api.openai.com` while the client called somewhere else entirely.
 * An embedding call carries the whole corpus, so that divergence was the
 * broadest egress hole in the codebase.
 */
const OPENAI_EMBEDDINGS_BASE_URL = "https://api.openai.com/v1";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;
  private client: OpenAI;
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
    if (!opts.apiKey) throw new EmbeddingError("OpenAI API key is required");
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      // Passed explicitly, never omitted. The SDK constructor destructures
      // `baseURL = readEnv("OPENAI_BASE_URL")`, so an ABSENT key is not the
      // same as the default — the environment variable wins, and would redirect
      // the client away from the very host `assertAllowed` vouches for below.
      baseURL: OPENAI_EMBEDDINGS_BASE_URL,
      // The allow-list only ever sees the first hop; refuse to follow a 3xx
      // that would carry the batch somewhere it never validated.
      fetch: egressSafeFetch() as unknown as OpenAI["fetch"],
    });
    this.model = opts.model ?? "text-embedding-3-small";
    this.dimensions = opts.dimensions ?? 1536;
    this.maxRetries = opts.maxRetries ?? 5;
    this._egressPolicy = opts.egressPolicy ?? EgressPolicy.fromEnv();
    this._throttle = createThrottle({
      ...(opts.requestsPerMinute !== undefined
        ? { requestsPerMinute: opts.requestsPerMinute }
        : {}),
    });
  }

  async embed(text: string): Promise<Embedding> {
    const [e] = await this.embedBatch([text]);
    if (!e) throw new EmbeddingError("OpenAI returned no embedding");
    return e;
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    if (texts.length === 0) return [];
    this._egressPolicy.assertAllowed(OPENAI_EMBEDDINGS_BASE_URL);
    try {
      const results: Embedding[] = [];
      const batchSize = 2048; // OpenAI limit
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        const resp = await this._throttle(() =>
          retryOnRateLimit(
            () =>
              this.client.embeddings.create({
                model: this.model,
                input: slice,
                dimensions: this.dimensions,
                encoding_format: "float",
              }),
            { maxRetries: this.maxRetries },
          ),
        );
        for (const item of resp.data) {
          results.push({
            vector: item.embedding,
            provider: this.name,
            model: this.model,
            dimensions: item.embedding.length,
          });
        }
      }
      return results;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `OpenAI embedding failed: ${(err as Error).message}`,
        err,
      );
    }
  }
}

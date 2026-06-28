import OpenAI from "openai";
import type { Embedding, EmbeddingProvider } from "@rag/core";
import { EgressPolicy, EmbeddingError } from "@rag/core";
import { retryOnRateLimit } from "./retry.js";

/**
 * OpenAI embedding provider. Use when you want maximum quality and don't
 * mind paying. `text-embedding-3-small` is 1536-dim, `-large` is 3072-dim.
 *
 * If you switch from Gemini (768) to OpenAI, you MUST change the vector
 * column dimension in the `chunks` table and re-embed everything.
 * See packages/db/drizzle/0000_init.sql for the migration recipe.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;
  private client: OpenAI;
  private readonly maxRetries: number;
  private readonly _egressPolicy: EgressPolicy;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    maxRetries?: number;
    egressPolicy?: EgressPolicy;
  }) {
    if (!opts.apiKey) throw new EmbeddingError("OpenAI API key is required");
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? "text-embedding-3-small";
    this.dimensions = opts.dimensions ?? 1536;
    this.maxRetries = opts.maxRetries ?? 5;
    this._egressPolicy = opts.egressPolicy ?? EgressPolicy.fromEnv();
  }

  async embed(text: string): Promise<Embedding> {
    const [e] = await this.embedBatch([text]);
    if (!e) throw new EmbeddingError("OpenAI returned no embedding");
    return e;
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    if (texts.length === 0) return [];
    this._egressPolicy.assertAllowed("https://api.openai.com");
    try {
      const results: Embedding[] = [];
      const batchSize = 2048; // OpenAI limit
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        const resp = await retryOnRateLimit(
          () =>
            this.client.embeddings.create({
              model: this.model,
              input: slice,
              dimensions: this.dimensions,
              encoding_format: "float",
            }),
          { maxRetries: this.maxRetries },
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

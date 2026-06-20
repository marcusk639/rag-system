import { GoogleGenAI } from "@google/genai";
import type { Embedding, EmbeddingProvider } from "@rag/core";
import { EmbeddingError } from "@rag/core";
import { retryOnRateLimit } from "./retry.js";

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
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly dimensions: number;
  private client: GoogleGenAI;
  private readonly maxRetries: number;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    maxRetries?: number;
  }) {
    if (!opts.apiKey) {
      throw new EmbeddingError("Gemini API key is required");
    }
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? "gemini-embedding-001";
    this.dimensions = opts.dimensions ?? 768;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  async embed(text: string): Promise<Embedding> {
    const [vec] = await this.embedBatch([text]);
    if (!vec) throw new EmbeddingError("Gemini returned no embedding");
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    if (texts.length === 0) return [];

    try {
      // Gemini's batch endpoint accepts up to 100 inputs per call.
      const results: Embedding[] = [];
      const batchSize = 100;
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        const response = await retryOnRateLimit(
          () =>
            this.client.models.embedContent({
              model: this.model,
              contents: slice,
              config: {
                outputDimensionality: this.dimensions,
                taskType: "RETRIEVAL_DOCUMENT",
              },
            }),
          { maxRetries: this.maxRetries },
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

import type { Embedding, EmbeddingProvider } from "@rag/core";
import { EmbeddingError } from "@rag/core";

/**
 * Local (on-process) embedding provider using @huggingface/transformers.
 *
 * Runs ONNX models in-process via the WebAssembly/ONNX runtime — no network
 * egress for embedding. This satisfies CR-1 (IRC §7216: TRI never reaches an
 * external embedding API) and CR-3 (US-located computation).
 *
 * Default model: Xenova/bge-base-en-v1.5 (768-d).
 *   - Matches the `chunks.embedding` pgvector column dimension (no migration).
 *   - Strong general retrieval quality for English firm documents.
 *   - ~430 MB on first startup; subsequent runs use the disk cache.
 *
 * First-startup note: the model weights are downloaded from HuggingFace Hub on
 * the first `embed()` call and cached at HF_CACHE_DIR (default:
 * ~/.cache/huggingface). Run `scripts/warm-model.ts` during image build or
 * deployment to pre-warm the cache so the first real query doesn't time out.
 *
 * BGE asymmetric retrieval: bge models recommend a query-side instruction
 * prefix ("Represent this sentence for searching relevant passages: ") so that
 * query and document embeddings are projected into compatible spaces. The
 * `embedQuery()` method applies the prefix; `embed()` and `embedBatch()` do
 * not (corpus/document side).
 */

// BGE-family query instruction prefix for retrieval tasks.
// Applied only to the query side (embedQuery) — not to corpus documents.
const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

// Minimal surface of the @huggingface/transformers pipeline we actually use,
// typed locally so the import stays dynamic (no top-level type dependency).
interface HFTensor {
  dims: number[];
  data: Float32Array;
}
type HFPipeline = (
  input: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<HFTensor>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model: string;
  readonly dimensions: number;

  // Cached promise — created once, shared across concurrent callers.
  // Storing the Promise (not the resolved value) means the first concurrent
  // `embed()` calls all await the same load rather than launching duplicate
  // downloads.
  private _pipelinePromise: Promise<HFPipeline> | null = null;

  constructor(opts: { model?: string; dimensions?: number } = {}) {
    this.model = opts.model ?? "Xenova/bge-base-en-v1.5";
    this.dimensions = opts.dimensions ?? 768;
  }

  /** Return the cached pipeline, loading it on first access. */
  private getPipeline(): Promise<HFPipeline> {
    if (!this._pipelinePromise) {
      this._pipelinePromise = this._loadPipeline();
    }
    return this._pipelinePromise;
  }

  private async _loadPipeline(): Promise<HFPipeline> {
    try {
      // Dynamic import keeps @huggingface/transformers out of the module graph
      // for non-local deployments (saves startup time + avoids ONNX init cost
      // when the provider is not configured).
      const { pipeline, env } = await import(
        "@huggingface/transformers" as string
      );

      // HF_CACHE_DIR lets the firm pin weights to a network share or a
      // known-good path on the deployment VM. Without it the default
      // (~/.cache/huggingface) is used, which is fine for local dev.
      if (process.env.HF_CACHE_DIR) {
        env.cacheDir = process.env.HF_CACHE_DIR;
      }

      const pipe = await pipeline("feature-extraction", this.model);
      return pipe as unknown as HFPipeline;
    } catch (err) {
      // Reset so a transient failure (e.g. network blip during first download)
      // can be retried by the caller rather than being permanently cached.
      this._pipelinePromise = null;
      throw new EmbeddingError(
        `Failed to load local embedding model "${this.model}": ${(err as Error).message}. ` +
          `Ensure @huggingface/transformers is installed and the model is reachable ` +
          `(first run requires internet access to download weights; subsequent runs use HF_CACHE_DIR).`,
        err,
      );
    }
  }

  async embed(text: string): Promise<Embedding> {
    const [vec] = await this.embedBatch([text]);
    if (!vec) throw new EmbeddingError("Local embedder returned no result");
    return vec;
  }

  /**
   * Embed a search QUERY. Prepends the BGE instruction prefix so the query
   * and document embeddings are projected into compatible retrieval spaces.
   * If a non-BGE model is configured, the prefix is still harmless (it adds
   * light context); remove it here if a specific model requires clean input.
   */
  async embedQuery(text: string): Promise<Embedding> {
    const [vec] = await this.embedBatch([BGE_QUERY_PREFIX + text]);
    if (!vec)
      throw new EmbeddingError("Local embedder returned no result for query");
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    if (texts.length === 0) return [];

    const pipe = await this.getPipeline();

    let output: HFTensor;
    try {
      output = await pipe(texts, { pooling: "mean", normalize: true });
    } catch (err) {
      throw new EmbeddingError(
        `Local embedding inference failed: ${(err as Error).message}`,
        err,
      );
    }

    const [batchSize, dims] = output.dims;

    // Dimension guard — catch model/config mismatches before they silently
    // produce wrong-shape vectors that corrupt the pgvector index.
    if (dims !== this.dimensions) {
      throw new EmbeddingError(
        `Model "${this.model}" output ${dims} dimensions but EMBEDDING_DIMENSIONS=${this.dimensions}. ` +
          `Set EMBEDDING_DIMENSIONS=${dims} or choose a ${this.dimensions}-d model.`,
      );
    }

    if (batchSize !== texts.length) {
      throw new EmbeddingError(
        `Local embedder returned ${batchSize} vectors for ${texts.length} inputs`,
      );
    }

    // Slice the flat Float32Array into per-item dense vectors.
    const results: Embedding[] = [];
    for (let i = 0; i < batchSize; i++) {
      const start = i * dims;
      const vector = Array.from(output.data.subarray(start, start + dims));
      results.push({
        vector,
        provider: this.name,
        model: this.model,
        dimensions: dims,
      });
    }
    return results;
  }
}

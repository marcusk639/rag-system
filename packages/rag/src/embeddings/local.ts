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

/**
 * Default token ceiling for the local model (Xenova/bge-base-en-v1.5's
 * 512-token limit). Used only as a fallback when the loaded tokenizer
 * doesn't expose its own `model_max_length`.
 */
const DEFAULT_MAX_TOKENS = 512;

/**
 * Minimal logger surface this file needs — matches the pino `.warn(details,
 * message)` call shape already used elsewhere in this codebase (e.g.
 * packages/runtime/src/index.ts), so a real pino logger drops in directly.
 * @rag/rag has no logging library dependency of its own, so when no logger
 * is injected we fall back to `console.warn` (same fallback rationale as
 * apps/web/src/lib/rag-api.ts, which has the same "no logging library" note).
 */
export interface EmbeddingLogger {
  warn: (details: Record<string, unknown>, message: string) => void;
}

const defaultLogger: EmbeddingLogger = {
  warn: (details, message) => console.warn(message, details),
};

// Minimal surface of the @huggingface/transformers pipeline we actually use,
// typed locally so the import stays dynamic (no top-level type dependency).
interface HFTensor {
  dims: number[];
  data: Float32Array;
}
/**
 * The tokenizer instance a loaded pipeline exposes as a public `.tokenizer`
 * property (see @huggingface/transformers' Pipeline base class). Calling it
 * directly (bypassing the pipeline's own inference call) is how we detect an
 * over-length input BEFORE the pipeline silently truncates it — the
 * FeatureExtractionPipeline's public options (`FeatureExtractionPipelineOptions`
 * in the installed package's own .d.ts) expose only pooling/normalize/quantize/
 * precision, with no truncation-related field at all; truncation is hardcoded
 * `true` inside the pipeline's internal tokenizer call and cannot be configured
 * through pipe(). Detecting overflow ourselves, via this same tokenizer, is the
 * only way to surface a warning without forking the library.
 */
interface HFTokenizer {
  model_max_length?: number;
  (
    text: string,
    opts?: { truncation?: boolean; padding?: boolean; return_tensor?: boolean },
  ): { input_ids: number[] | number[][] };
}
type HFPipeline = ((
  input: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<HFTensor>) & { tokenizer: HFTokenizer };

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model: string;
  readonly dimensions: number;

  // Cached promise — created once, shared across concurrent callers.
  // Storing the Promise (not the resolved value) means the first concurrent
  // `embed()` calls all await the same load rather than launching duplicate
  // downloads.
  private _pipelinePromise: Promise<HFPipeline> | null = null;
  private readonly logger: EmbeddingLogger;
  private readonly maxTokens: number;

  constructor(
    opts: {
      model?: string;
      dimensions?: number;
      logger?: EmbeddingLogger;
      maxTokens?: number;
    } = {},
  ) {
    this.model = opts.model ?? "Xenova/bge-base-en-v1.5";
    this.dimensions = opts.dimensions ?? 768;
    this.logger = opts.logger ?? defaultLogger;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
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

  /**
   * Backstop for the rare chunk that still exceeds the token limit after the
   * provider-aware CHUNK_SIZE cap (packages/core/src/config.ts). Tokenizes
   * each text WITHOUT truncation (bypassing the pipeline's hardcoded
   * truncation) to find its true length, then logs — never throws — when a
   * text will be truncated by the actual embedding call below. Detection is
   * best-effort: any failure here is swallowed so it can never block the
   * real embed.
   */
  private warnOnOverlongText(pipe: HFPipeline, texts: string[]): void {
    const limit = pipe.tokenizer.model_max_length ?? this.maxTokens;
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      let tokenCount: number;
      try {
        const encoded = pipe.tokenizer(text, {
          truncation: false,
          padding: false,
          return_tensor: false,
        });
        tokenCount = Array.isArray(encoded.input_ids)
          ? encoded.input_ids.length
          : 0;
      } catch {
        continue;
      }
      if (tokenCount > limit) {
        this.logger.warn(
          {
            textIndex: i,
            tokenCount,
            limit,
            textPreview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
          },
          `Local embedding input exceeds the ${limit}-token model limit ` +
            `(${tokenCount} tokens) and will be truncated by ` +
            `@huggingface/transformers, degrading retrieval quality for this ` +
            `chunk. Lower CHUNK_SIZE or split this document further.`,
        );
      }
    }
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    if (texts.length === 0) return [];

    const pipe = await this.getPipeline();

    this.warnOnOverlongText(pipe, texts);

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

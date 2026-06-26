import type { Config, Reranker, RetrievalResult } from "@rag/core";
import { ValidationError } from "@rag/core";

/**
 * Hosted cross-encoder reranker for the Cohere / Jina rerank REST APIs, which
 * share the same request/response shape:
 *   POST { model, query, documents: string[], top_n }  (Bearer key)
 *   ->   { results: [{ index, relevance_score }] }  (sorted, best first)
 *
 * We send only the chunk text and map the returned indices back to the original
 * `RetrievalResult` objects (no mutation, no fabrication — only re-order +
 * truncate). Errors throw; the Retriever degrades to the pre-rerank RRF order.
 */
export class HttpCrossEncoderReranker implements Reranker {
  constructor(
    private readonly opts: {
      name: string;
      endpoint: string;
      model: string;
      apiKey: string;
    },
  ) {}

  get name(): string {
    return this.opts.name;
  }

  async rerank(
    query: string,
    candidates: RetrievalResult[],
    topK: number,
  ): Promise<RetrievalResult[]> {
    if (candidates.length === 0) return [];

    const response = await fetch(this.opts.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        query,
        documents: candidates.map((c) => c.text),
        top_n: Math.min(topK, candidates.length),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `${this.opts.name} rerank failed: ${response.status} ${detail}`.trim(),
      );
    }

    const body = (await response.json()) as {
      results?: Array<{ index: number; relevance_score?: number }>;
    };
    const ranked = body.results ?? [];

    // Map provider indices back to our candidates, dropping any out-of-range
    // index defensively. Reuse the original objects (RRF scores preserved); the
    // array order now reflects relevance.
    return ranked
      .filter((r) => Number.isInteger(r.index) && candidates[r.index])
      .slice(0, topK)
      .map((r) => candidates[r.index]!);
  }
}

/**
 * Build the configured reranker, or `null` when reranking is disabled
 * (`RERANK_PROVIDER=none`). A null reranker means the Retriever keeps the exact
 * pre-rerank behavior — it does not over-fetch a candidate pool.
 *
 * Adding a provider: implement `Reranker`, add a case here, extend the
 * `rerank.provider` enum in packages/core/src/config.ts.
 */
export function createReranker(cfg: Config["rerank"]): Reranker | null {
  switch (cfg.provider) {
    case "none":
      return null;
    case "cohere":
      if (!cfg.apiKey)
        throw new ValidationError(
          "RERANK_API_KEY required for cohere reranker",
        );
      return new HttpCrossEncoderReranker({
        name: "cohere",
        endpoint: "https://api.cohere.com/v2/rerank",
        model: cfg.model ?? "rerank-v3.5",
        apiKey: cfg.apiKey,
      });
    case "jina":
      if (!cfg.apiKey)
        throw new ValidationError("RERANK_API_KEY required for jina reranker");
      return new HttpCrossEncoderReranker({
        name: "jina",
        endpoint: "https://api.jina.ai/v1/rerank",
        model: cfg.model ?? "jina-reranker-v2-base-multilingual",
        apiKey: cfg.apiKey,
      });
    case "llm":
      throw new ValidationError(
        "llm reranker not yet implemented — set RERANK_PROVIDER=cohere|jina|none",
      );
  }
}

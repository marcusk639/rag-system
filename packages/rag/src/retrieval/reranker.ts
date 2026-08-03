import type { Config, Reranker, RetrievalResult } from "@rag/core";
import { EgressPolicy, ValidationError } from "@rag/core";

/**
 * Hosted cross-encoder reranker for the Cohere / Jina rerank REST APIs, which
 * share the same request/response shape:
 *   POST { model, query, documents: string[], top_n }  (Bearer key)
 *   ->   { results: [{ index, relevance_score }] }  (sorted, best first)
 *
 * Verified against both vendors' current docs on 2026-08-01 (Cohere v2
 * `POST /v2/rerank`; Jina `POST /v1/rerank`, checked against its live OpenAPI
 * spec): the shared shape holds, `index` is 0-based on both, and both sort
 * best-first. Defaults differ even where field names agree — see the
 * `return_documents` note in the plan.
 *
 * We send only the chunk text and map the returned indices back to the original
 * `RetrievalResult` objects (no mutation, no fabrication — only re-order +
 * truncate). Errors throw; the Retriever degrades to the pre-rerank RRF order.
 *
 * ## Egress
 *
 * `rerank()` sends **firm document text** to a third-party vendor, which makes
 * it an egress event in exactly the sense `EgressPolicy` exists to govern. It is
 * gated on the same allow-list as embeddings (`embeddings/gemini.ts`),
 * generation (`generation/generator.ts`), and audit-log shipping
 * (`audit-sink/http-webhook.ts`) — so no rerank call can happen against a host
 * nobody has made a DPA decision about. Before this gate existed, enabling
 * `RERANK_PROVIDER=cohere` was the one outbound path in the system with no
 * egress control at all.
 */
export class HttpCrossEncoderReranker implements Reranker {
  private readonly egressPolicy: EgressPolicy;

  constructor(
    private readonly opts: {
      name: string;
      endpoint: string;
      model: string;
      apiKey: string;
      /**
       * Defaults to `EgressPolicy.fromEnv()` so a directly-constructed instance
       * is still gated — matching `GeminiGenerator`/`OpenAIGenerator`. The
       * runtime injects the shared policy so every provider honours one
       * allow-list.
       */
      egressPolicy?: EgressPolicy;
    },
  ) {
    this.egressPolicy = opts.egressPolicy ?? EgressPolicy.fromEnv();
  }

  get name(): string {
    return this.opts.name;
  }

  async rerank(
    query: string,
    candidates: RetrievalResult[],
    topK: number,
  ): Promise<RetrievalResult[]> {
    // Order matters: an empty candidate set makes no network call, so refusing
    // it on egress grounds would fail a query whose text was never going to
    // leave the process. Short-circuit first, then gate.
    if (candidates.length === 0) return [];

    this.egressPolicy.assertAllowed(this.opts.endpoint);

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
 * `opts.egressPolicy` mirrors `createEmbeddingProvider`/`createAuditLogSink`:
 * the runtime builds ONE policy and hands it to every provider, so a single
 * `EGRESS_ALLOWED_HOSTS` governs all outbound calls. Omitting it falls back to
 * `EgressPolicy.fromEnv()` inside the reranker — never to "unrestricted".
 *
 * Adding a provider: implement `Reranker`, add a case here, extend the
 * `rerank.provider` enum in packages/core/src/config.ts.
 */
export function createReranker(
  cfg: Config["rerank"],
  opts?: { egressPolicy?: EgressPolicy },
): Reranker | null {
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
        egressPolicy: opts?.egressPolicy,
      });
    case "jina":
      if (!cfg.apiKey)
        throw new ValidationError("RERANK_API_KEY required for jina reranker");
      return new HttpCrossEncoderReranker({
        name: "jina",
        endpoint: "https://api.jina.ai/v1/rerank",
        model: cfg.model ?? "jina-reranker-v2-base-multilingual",
        apiKey: cfg.apiKey,
        egressPolicy: opts?.egressPolicy,
      });
    case "llm":
      throw new ValidationError(
        "llm reranker not yet implemented — set RERANK_PROVIDER=cohere|jina|none",
      );
  }
}

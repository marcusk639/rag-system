import { createHash } from "node:crypto";
import type { Embedding, EmbeddingProvider } from "@rag/core";

/**
 * Deterministic bag-of-words embedder.
 *
 *   - 768 dims (matches the chunks.embedding column).
 *   - Tokenises on word boundaries, hashes each token, accumulates into the
 *     vector via hash-mod-N. Texts that share words map to overlapping
 *     coordinates → meaningful cosine similarity for retrieval ranking.
 *   - No network calls, no randomness, no API key required. Same input ⇒ same
 *     bytes, every time.
 *
 * This is NOT a semantic embedder. It's enough to:
 *   1. Satisfy the NOT NULL embedding column.
 *   2. Make retrieval ranking deterministic and assertable in tests.
 *   3. Demonstrate that "documents sharing keywords with the query rank
 *      higher than disjoint documents," which is the contract real embedders
 *      uphold and the one we want our pipeline tests to verify.
 */
const DIMS = 768;

export class FakeEmbedder implements EmbeddingProvider {
  readonly name = "local";
  readonly model = "fake-bow-768";
  readonly dimensions = DIMS;

  async embed(text: string): Promise<Embedding> {
    return {
      vector: embed(text),
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    return texts.map((t) => ({
      vector: embed(t),
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
    }));
  }
}

function embed(text: string): number[] {
  const vec = new Float64Array(DIMS);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    // Use two slots per token (one positive, one alternating sign) so vectors
    // discriminate slightly better than a pure presence histogram.
    const slot1 = digest.readUInt32BE(0) % DIMS;
    const slot2 = digest.readUInt32BE(4) % DIMS;
    vec[slot1] = (vec[slot1] ?? 0) + 1;
    vec[slot2] = (vec[slot2] ?? 0) + (digest[8]! % 2 === 0 ? 1 : -1);
  }
  // L2-normalise so cosine similarity equals dot product.
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i]! * vec[i]!;
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  const out = new Array<number>(DIMS);
  for (let i = 0; i < DIMS; i++) out[i] = (vec[i] ?? 0) * inv;
  return out;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

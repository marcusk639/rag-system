/**
 * One-off ops script: re-embed every chunk's stored text in place using the
 * configured Gemini embedder, so retrieval query vectors (Gemini) and stored
 * chunk vectors live in the SAME space.
 *
 * The eval corpus was seeded with a fake bag-of-words embedder (fake-bow-768),
 * which makes dense retrieval meaningless against real Gemini query embeddings.
 * This rewrites `embedding` / `embedding_provider` / `embedding_model` for all
 * chunks. Idempotent: re-running with the same model produces the same vectors.
 *
 * Run (Gemini key from env only — never committed):
 *   GEMINI_API_KEY=your-key EMBEDDING_PROVIDER=gemini \
 *     pnpm --filter @rag/runtime exec tsx scripts/reembed-chunks.ts
 */
import { loadConfig } from "@rag/core";
import { createEmbeddingProvider } from "@rag/rag";
import { createDb } from "@rag/db";

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.embedding.provider !== "gemini") {
    throw new Error(
      `EMBEDDING_PROVIDER must be 'gemini' for this re-embed (got '${config.embedding.provider}').`,
    );
  }

  const embedder = createEmbeddingProvider(config.embedding);
  const { pool, close } = createDb(config.databaseUrl);

  try {
    const { rows } = await pool.query<{ id: string; text: string }>(
      "select id, text from chunks order by id",
    );
    console.log(
      `Re-embedding ${rows.length} chunks with ${config.embedding.provider}/${config.embedding.model} (${config.embedding.dimensions}d) ...`,
    );

    let updated = 0;
    for (const row of rows) {
      const { vector } = await embedder.embed(row.text);
      if (vector.length !== config.embedding.dimensions) {
        throw new Error(
          `Chunk ${row.id}: got ${vector.length}d, expected ${config.embedding.dimensions}d`,
        );
      }
      // pgvector text literal: '[v1,v2,...]'.
      const literal = `[${vector.join(",")}]`;
      await pool.query(
        "update chunks set embedding = $1, embedding_provider = $2, embedding_model = $3 where id = $4",
        [literal, config.embedding.provider, config.embedding.model, row.id],
      );
      updated++;
      if (updated % 25 === 0 || updated === rows.length) {
        console.log(`  ${updated}/${rows.length}`);
      }
    }

    console.log(`Done. Updated ${updated} chunks.`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

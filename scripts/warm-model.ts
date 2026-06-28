/**
 * Pre-warm the local ONNX embedding model.
 *
 * Run this during image build or as a deploy-time startup script so the first
 * real query does not time out waiting for ~430 MB of model weights to
 * download. Subsequent starts read from HF_CACHE_DIR (disk cache; no network).
 *
 * Usage:
 *   npx tsx scripts/warm-model.ts
 *
 * Environment variables:
 *   EMBEDDING_MODEL   — HuggingFace model id (default: Xenova/bge-base-en-v1.5)
 *   HF_CACHE_DIR      — cache directory (default: ~/.cache/huggingface)
 */
import { createEmbeddingProvider } from "@rag/rag";

const model = process.env["EMBEDDING_MODEL"] ?? "Xenova/bge-base-en-v1.5";
const cacheDir = process.env["HF_CACHE_DIR"];

if (cacheDir) {
  process.stdout.write(`Using HF_CACHE_DIR: ${cacheDir}\n`);
}

process.stdout.write(`Warming local embedding model: ${model} …\n`);

const provider = createEmbeddingProvider({
  provider: "local",
  model,
  dimensions: 768,
});

await provider.embed("warmup");

process.stdout.write(
  `Model ready. Cache: ${cacheDir ?? "~/.cache/huggingface"}\n`,
);

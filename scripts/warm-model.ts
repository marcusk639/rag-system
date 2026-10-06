/**
 * Pre-warm the local ONNX embedding model.
 *
 * Run this during image build or as a deploy-time startup script so the first
 * real query does not time out waiting for ~430 MB of model weights to
 * download. Subsequent starts read from HF_CACHE_DIR (disk cache; no network).
 *
 * Usage:
 *   HF_CACHE_DIR=<path> EMBEDDING_MODEL=Xenova/bge-base-en-v1.5 \
 *     npx tsx scripts/warm-model.ts
 *
 * Set both. Bare `npx tsx scripts/warm-model.ts` warms the wrong model into a
 * directory the runtime does not read -- see the two notes below.
 *
 * Environment variables:
 *   EMBEDDING_MODEL   — HuggingFace model id (default here: Xenova/bge-base-en-v1.5).
 *                       NOTE this differs from the runtime default: config.ts
 *                       defaults EMBEDDING_MODEL to gemini-embedding-001
 *                       regardless of provider, so warming without it set
 *                       warms a model the service never asks for.
 *   HF_CACHE_DIR      — cache directory. Unset, @huggingface/transformers caches
 *                       inside its own node_modules directory, which does not survive
 *                       a multi-stage image copy or a prod-only reinstall. Set it.
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
  `Model ready. Cache: ${cacheDir ?? "(unset -- a .cache/ dir inside the installed @huggingface/transformers package; set HF_CACHE_DIR)"}\n`,
);

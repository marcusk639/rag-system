/**
 * Pre-warm the local ONNX embedding model.
 *
 * Run this during image build or as a deploy-time startup script so the first
 * real query does not time out waiting for ~430 MB of model weights to
 * download. Subsequent starts read from HF_CACHE_DIR (disk cache; no network).
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/warm-model.ts   # or: pnpm tsx scripts/warm-model.ts
 *
 * NOT `npx tsx`: npx fetches tsx over the network, and a production image
 * built by `pnpm deploy --prod` has tsx pruned. In a Dockerfile, call
 * scripts/warm-model-verified.sh instead, which wraps this with the
 * cache-populated check the build gates on.
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

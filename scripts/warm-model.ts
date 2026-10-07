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
 *   EMBEDDING_MODEL   — HuggingFace model id. Unset or empty, this falls back
 *                       to `defaultEmbeddingModel("local")` from @rag/core —
 *                       the SAME function loadConfig uses — so the warmed
 *                       model cannot drift from the one the service asks for.
 *                       This script does not call loadConfig (that would
 *                       demand a full runtime env, DATABASE_URL included), so
 *                       sharing the function is what keeps the two in step.
 *   HF_CACHE_DIR      — cache directory. Unset, @huggingface/transformers caches
 *                       inside its own node_modules directory, which does not survive
 *                       a multi-stage image copy or a prod-only reinstall. Set it.
 */
import { defaultEmbeddingModel } from "@rag/core";
import { createEmbeddingProvider } from "@rag/rag";

// This script warms the LOCAL ONNX weight cache and nothing else: a remote
// provider has no on-disk cache to populate, and constructing one here would
// make an image build issue a billable API call that produces no cache.
// EMBEDDING_PROVIDER defaults to `gemini` in env.example and
// docker/compose.prod.yml, so an unchecked hardcode of "local" below would
// silently disagree with the deployment it is warming for. Check it rather
// than assume it. Empty counts as unset: Compose and Railway inject an
// always-present empty variable rather than omitting it.
const requestedProvider = process.env["EMBEDDING_PROVIDER"]?.trim();
if (requestedProvider && requestedProvider !== "local") {
  process.stderr.write(
    `EMBEDDING_PROVIDER=${requestedProvider} has no local weight cache to ` +
      `warm; this script only populates the local ONNX cache. Unset it, or ` +
      `set it to "local", for the warm step.\n`,
  );
  process.exit(1);
}

// `||` not `??`: Compose and Railway inject an always-present but empty
// variable rather than omitting it, and "" must fall through too.
const model = process.env["EMBEDDING_MODEL"] || defaultEmbeddingModel("local");
const cacheDir = process.env["HF_CACHE_DIR"];

if (cacheDir) {
  process.stdout.write(`Using HF_CACHE_DIR: ${cacheDir}\n`);
}

process.stdout.write(`Warming local embedding model: ${model} …\n`);

const provider = createEmbeddingProvider({
  provider: "local",
  model,
  dimensions: 768,
  // Required by the TYPE, not by this provider. `Config["embedding"]` is zod's
  // OUTPUT type, where a `.default()`ed field is required rather than optional,
  // so both must be supplied even though LocalEmbeddingProvider reads neither:
  // they govern remote-API 429 backoff and client-side request pacing (see
  // gemini.ts / openai.ts / retry.ts), and an in-process ONNX model has no
  // rate limit to respect. Zero rather than a plausible number, so nothing
  // here reads as rate-limit awareness that does not exist.
  maxRetries: 0,
  requestsPerMinute: 0,
});

await provider.embed("warmup");

process.stdout.write(
  `Model ready. Cache: ${cacheDir ?? "(unset -- a .cache/ dir inside the installed @huggingface/transformers package; set HF_CACHE_DIR)"}\n`,
);

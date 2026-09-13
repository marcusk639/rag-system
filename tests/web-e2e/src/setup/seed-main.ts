import { seedCorpus } from "./seed.js";

/**
 * Standalone entry point for `seedCorpus()`, run as a CHILD process by
 * `global-setup.ts` (via `tsx`).
 *
 * Why a child process: `LocalEmbeddingProvider` loads an ONNX pipeline via
 * `@huggingface/transformers` (`onnxruntime-node`), and that native addon
 * reliably SIGABRTs during process teardown once a pipeline has been loaded
 * in-process (`libc++abi: ... mutex lock failed`). Running the seed here,
 * out of the Playwright runner's own process, means that crash only takes
 * down this short-lived child — the runner (and the actual test results)
 * are unaffected. `global-setup.ts` does not trust this process's exit code
 * for success (it tolerates exactly the SIGABRT/134 crash after a normal
 * completion); it re-verifies success by querying the database directly.
 */
seedCorpus()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[web-e2e] seedCorpus failed:", err);
    process.exit(1);
  });

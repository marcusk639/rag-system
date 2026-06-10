import { RagError } from "@rag/core";

/**
 * `askQuestion` was called but no generation provider is configured on the
 * server. Adapters map this to HTTP 503 / MCP isError. Kept as a typed error
 * (rather than a null-return) so every transport reacts identically.
 */
export class GenerationNotConfiguredError extends RagError {
  constructor() {
    super(
      "Generation is not configured. Set GENERATION_PROVIDER and GENERATION_MODEL to enable ask.",
      "GENERATION_NOT_CONFIGURED",
    );
  }
}

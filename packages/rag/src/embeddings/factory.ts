import type { Config, EmbeddingProvider } from "@rag/core";
import { ValidationError } from "@rag/core";
import { GeminiEmbeddingProvider } from "./gemini.js";
import { OpenAIEmbeddingProvider } from "./openai.js";

/**
 * Build the configured embedding provider. Centralizing this here means apps
 * never `new GeminiEmbeddingProvider()` directly — they pass the config and
 * get back the right implementation.
 *
 * Adding a new provider:
 *   1. Implement `EmbeddingProvider` in a new file under embeddings/
 *   2. Add a case here
 *   3. Add its enum value to Config in packages/core/src/config.ts
 */
export function createEmbeddingProvider(
  cfg: Config["embedding"],
): EmbeddingProvider {
  switch (cfg.provider) {
    case "gemini":
      if (!cfg.apiKey)
        throw new ValidationError(
          "GEMINI_API_KEY required for gemini provider",
        );
      return new GeminiEmbeddingProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        dimensions: cfg.dimensions,
      });
    case "openai":
      if (!cfg.apiKey)
        throw new ValidationError(
          "OPENAI_API_KEY required for openai provider",
        );
      return new OpenAIEmbeddingProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        dimensions: cfg.dimensions,
      });
    case "local":
      throw new ValidationError(
        "local provider not yet implemented — install @xenova/transformers and add a LocalEmbeddingProvider",
      );
  }
}

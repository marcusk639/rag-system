import type { Config, EmbeddingProvider } from "@rag/core";
import { ComplianceError, EgressPolicy, ValidationError } from "@rag/core";
import { GeminiEmbeddingProvider } from "./gemini.js";
import { LocalEmbeddingProvider } from "./local.js";
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
  opts?: {
    egressPolicy?: EgressPolicy;
    complianceMode?: "none" | "client-data";
  },
): EmbeddingProvider {
  // Finding 3: compliance-mode hard gate — TRI must never leave the process.
  if (opts?.complianceMode === "client-data" && cfg.provider !== "local") {
    throw new ComplianceError(
      `COMPLIANCE_MODE=client-data requires EMBEDDING_PROVIDER=local, ` +
        `but provider is "${cfg.provider}". ` +
        `Sending embeddings to an external API would expose TRI (IRC §7216).`,
    );
  }

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
        maxRetries: cfg.maxRetries,
        egressPolicy: opts?.egressPolicy,
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
        maxRetries: cfg.maxRetries,
        egressPolicy: opts?.egressPolicy,
      });
    case "local":
      // No API key required — all inference runs on-process via ONNX.
      // Satisfies CR-1/CR-3: no TRI egress for embeddings (§7216 compliance).
      return new LocalEmbeddingProvider({
        model: cfg.model,
        dimensions: cfg.dimensions,
      });
  }
}

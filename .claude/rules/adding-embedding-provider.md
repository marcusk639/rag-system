---
paths: ["packages/rag/src/embeddings/**"]
---

## Adding a new embedding provider

1. Implement `EmbeddingProvider` in `packages/rag/src/embeddings/<name>.ts`.
2. Register it in `packages/rag/src/embeddings/factory.ts`.
3. Document the model + dimensions in `env.example` and `docs/architecture/ARCHITECTURE.md`.

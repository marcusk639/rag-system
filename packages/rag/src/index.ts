// Embeddings
export { GeminiEmbeddingProvider } from "./embeddings/gemini.js";
export { OpenAIEmbeddingProvider } from "./embeddings/openai.js";
export { createEmbeddingProvider } from "./embeddings/factory.js";

// Parser client (calls the Python sidecar)
export { HttpParserClient } from "./parser/parser-client.js";

// Chunking
export {
  MarkdownChunker,
  type MarkdownChunkerOptions,
} from "./chunking/markdown-chunker.js";
export {
  TableChunker,
  type TableChunkerOptions,
  type TableChunkInput,
} from "./chunking/table-chunker.js";
export {
  CompositeChunker,
  type CompositeChunkerOptions,
} from "./chunking/composite-chunker.js";
export {
  MAX_EMBEDDING_TOKENS,
  clampToTokenLimit,
} from "./chunking/token-clamp.js";

// Object storage (originals for downloadable citations)
export { S3ObjectStore } from "./storage/s3-object-store.js";
export { createObjectStore, documentStorageKey } from "./storage/factory.js";

// Retrieval
export { Retriever } from "./retrieval/retriever.js";
export {
  HttpCrossEncoderReranker,
  createReranker,
} from "./retrieval/reranker.js";

// Generation
export {
  GeminiGenerator,
  OpenAIGenerator,
  createGenerator,
  buildCitations,
  type Generator,
  type GenerationResult,
} from "./generation/generator.js";

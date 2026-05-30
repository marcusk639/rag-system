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

// Retrieval
export { Retriever } from "./retrieval/retriever.js";

// Generation
export {
  GeminiGenerator,
  OpenAIGenerator,
  createGenerator,
  type Generator,
  type GenerationResult,
} from "./generation/generator.js";
